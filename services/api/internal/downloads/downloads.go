// Package downloads keeps full copies of torrent files on the server
// ("Скачать на сервер", for slow torrents): a background worker reads the
// file sequentially through TorrServer's stream endpoint (which makes
// TorrServer fetch every piece) into LIBRARY_DIR, and playback then serves
// the local file through the same stream URL. Completed files are kept at
// least keep_days and evicted, oldest first, only when space is needed.
// See docs/architecture.md "Server downloads".
package downloads

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/audit"
	"martytv/api/internal/catalog"
	"martytv/api/internal/config"
	"martytv/api/internal/db"
	"martytv/api/internal/integrations/torrserver"
	"martytv/api/internal/playback"
	"martytv/api/internal/realtime"
)

// Statuses.
const (
	StatusQueued       = "queued"
	StatusDownloading  = "downloading"
	StatusPaused       = "paused"
	StatusDone         = "done"
	StatusFailed       = "failed"
	StatusWaitingSpace = "waiting_space"
)

// Error codes.
const (
	ErrInsufficientSpace = "insufficient_space"
	ErrSizeMismatch      = "size_mismatch"
	ErrUpstream          = "upstream_error"
	ErrWrite             = "write_error"
)

// Catalog provides media cards.
type Catalog interface {
	SummariesByID(ctx context.Context, ids []string, lang string) (map[string]catalog.MediaSummary, error)
}

// Notifier delivers realtime events.
type Notifier interface {
	NotifyUsers(userIDs []string, env realtime.Envelope)
}

// Deps wires the service.
type Deps struct {
	Pool     *pgxpool.Pool
	Playback *playback.Service
	Catalog  Catalog
	Hub      Notifier
	Audit    *audit.Logger
	Config   config.LibraryConfig
	Log      *slog.Logger
}

// Timings are tunable for tests.
type Timings struct {
	CheckpointBytes int64
	CheckpointEvery time.Duration
	Idle            time.Duration // no upstream bytes → retry
	BackoffBase     time.Duration // first retry delay (doubles, capped)
	BackoffMax      time.Duration
	MaxFailures     int           // consecutive failures without progress → failed
	Tick            time.Duration // scheduler re-check (waiting_space, retries)
	Janitor         time.Duration
	EventEvery      time.Duration // progress event throttle per download
	WatchedEvery    time.Duration // last_watched_at write throttle
}

func DefaultTimings() Timings {
	return Timings{
		CheckpointBytes: 64 << 20, CheckpointEvery: 10 * time.Second, Idle: 2 * time.Minute,
		BackoffBase: 15 * time.Second, BackoffMax: 15 * time.Minute, MaxFailures: 20,
		Tick: 30 * time.Second, Janitor: time.Hour, EventEvery: 2 * time.Second, WatchedEvery: 5 * time.Minute,
	}
}

// Service runs downloads and serves /downloads.
type Service struct {
	pool  *pgxpool.Pool
	pb    *playback.Service
	ts    *torrserver.Client
	cat   Catalog
	hub   Notifier
	audit *audit.Logger
	log   *slog.Logger
	dir   string
	jobs  int

	// DiskStats reads the library filesystem (tests inject a fake).
	DiskStats func(path string) (DiskStats, error)
	now       func() time.Time
	t         Timings

	wake chan struct{}

	mu        sync.Mutex
	running   map[string]*job      // download id → running job
	retryAt   map[string]time.Time // download id → not before (backoff)
	failures  map[string]int
	lastEvent map[string]time.Time
	watched   map[string]time.Time
	bg        sync.WaitGroup
}

func NewService(d Deps) *Service {
	return &Service{
		pool: d.Pool, pb: d.Playback, ts: d.Playback.TorrServer(), cat: d.Catalog, hub: d.Hub, audit: d.Audit,
		log: d.Log.With("module", "downloads"), dir: d.Config.Dir, jobs: max(1, d.Config.MaxJobs),
		DiskStats: StatFS, now: time.Now, t: DefaultTimings(),
		wake:    make(chan struct{}, 1),
		running: map[string]*job{}, retryAt: map[string]time.Time{}, failures: map[string]int{},
		lastEvent: map[string]time.Time{}, watched: map[string]time.Time{},
	}
}

// SetTimings replaces the timings (tests).
func (s *Service) SetTimings(t Timings) { s.t = t }

// Wait blocks until running jobs and background writes have stopped (tests).
func (s *Service) Wait() { s.bg.Wait() }

func (s *Service) kick() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// ---- rows ----

type row struct {
	ID            string
	InfoHash      string
	FileIndex     int
	FilePath      string
	Size          int64
	MediaID       *string
	EpisodeID     *string
	ReleaseTitle  string
	SourceID      *string
	Status        string
	Error         *string
	SpaceNeeded   *int64
	BytesDone     int64
	Pinned        bool
	CreatedBy     *string
	CreatedAt     time.Time
	StartedAt     *time.Time
	CompletedAt   *time.Time
	LastWatchedAt *time.Time
	// Joined.
	Season, Episode *int
}

const rowCols = `d.id, d.info_hash, d.file_index, d.file_path, d.size, d.media_id, d.episode_id, d.release_title, d.source_id,
	d.status, d.error, d.space_needed, d.bytes_done, d.pinned, d.created_by, d.created_at, d.started_at, d.completed_at,
	d.last_watched_at, e.season_number, e.episode_number`

const rowFrom = ` FROM downloads d LEFT JOIN episodes e ON e.id = d.episode_id`

func scanRow(r pgx.Row) (*row, error) {
	var d row
	err := r.Scan(&d.ID, &d.InfoHash, &d.FileIndex, &d.FilePath, &d.Size, &d.MediaID, &d.EpisodeID, &d.ReleaseTitle, &d.SourceID,
		&d.Status, &d.Error, &d.SpaceNeeded, &d.BytesDone, &d.Pinned, &d.CreatedBy, &d.CreatedAt, &d.StartedAt, &d.CompletedAt,
		&d.LastWatchedAt, &d.Season, &d.Episode)
	if db.IsNoRows(err) {
		return nil, errNotFound
	}
	return &d, err
}

var errNotFound = errors.New("not found")

func (s *Service) get(ctx context.Context, id string) (*row, error) {
	return scanRow(s.pool.QueryRow(ctx, `SELECT `+rowCols+rowFrom+` WHERE d.id = $1`, id))
}

func (s *Service) byKey(ctx context.Context, hash string, index int) (*row, error) {
	return scanRow(s.pool.QueryRow(ctx, `SELECT `+rowCols+rowFrom+` WHERE d.info_hash = $1 AND d.file_index = $2`, hash, index))
}

func (s *Service) candidate(d *row) candidate {
	size := d.BytesDone
	if d.Status == StatusDone {
		size = d.Size
	}
	return candidate{ID: d.ID, Size: size, Status: d.Status, Pinned: d.Pinned, CompletedAt: d.CompletedAt, LastWatchedAt: d.LastWatchedAt}
}

// ---- files ----

// fileExt is the torrent file's extension when it is safe to use.
func fileExt(p string) string {
	ext := strings.ToLower(path.Ext(strings.ReplaceAll(p, "\\", "/")))
	if len(ext) < 2 || len(ext) > 6 {
		return ""
	}
	for _, r := range ext[1:] {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return ""
		}
	}
	return ext
}

func (s *Service) hashDir(hash string) string { return filepath.Join(s.dir, hash) }

func (s *Service) partPath(d *row) string {
	return filepath.Join(s.hashDir(d.InfoHash), strconv.Itoa(d.FileIndex)+".part")
}

func (s *Service) finalPath(d *row) string {
	return filepath.Join(s.hashDir(d.InfoHash), strconv.Itoa(d.FileIndex)+fileExt(d.FilePath))
}

// removeFiles deletes a download's files (part and final) and its hash
// directory when it is empty.
func (s *Service) removeFiles(d *row) {
	for _, p := range []string{s.partPath(d), s.finalPath(d)} {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			s.log.Warn("remove download file", "download_id", d.ID, "err", err)
		}
	}
	_ = os.Remove(s.hashDir(d.InfoHash)) // only succeeds when empty
}

// onDisk is the bytes a download occupies now.
func (s *Service) onDisk(d *row) int64 {
	if d.Status == StatusDone {
		return d.Size
	}
	if st, err := os.Stat(s.partPath(d)); err == nil {
		return st.Size()
	}
	return 0
}

// ready checks that the library directory exists (creating it) and is writable.
func (s *Service) ready() bool {
	if err := os.MkdirAll(s.dir, 0o750); err != nil {
		return false
	}
	f, err := os.CreateTemp(s.dir, ".probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	_ = os.Remove(name)
	return true
}

// ---- settings ----

func (s *Service) settings(ctx context.Context) (Settings, error) {
	st := Settings{ReserveGB: 15, KeepDays: 30}
	err := s.pool.QueryRow(ctx, `SELECT reserve_gb, max_library_gb, keep_days FROM library_settings WHERE id = 1`).
		Scan(&st.ReserveGB, &st.MaxLibraryGB, &st.KeepDays)
	if db.IsNoRows(err) {
		return st, nil
	}
	return st, err
}

// libraryUsed is the bytes of completed downloads plus partial progress.
func (s *Service) libraryUsed(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(SUM(CASE WHEN status = 'done' THEN size ELSE bytes_done END), 0)::bigint FROM downloads`).Scan(&n)
	return n, err
}

// ---- API shape ----

// UserRef is a requester (admin list).
type UserRef struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

// Download is the API representation (contract: Download).
type Download struct {
	ID            string                `json:"id"`
	Status        string                `json:"status"`
	Error         *string               `json:"error"`
	Progress      float64               `json:"progress"`
	BytesDone     int64                 `json:"bytes_done"`
	Size          int64                 `json:"size"`
	RateBps       *float64              `json:"rate_bps"`
	ETASeconds    *int64                `json:"eta_seconds"`
	Pinned        bool                  `json:"pinned"`
	Mine          bool                  `json:"mine"`
	InfoHash      string                `json:"info_hash"`
	FileIndex     int                   `json:"file_index"`
	FileName      string                `json:"file_name"`
	ReleaseTitle  string                `json:"release_title"`
	MediaID       *string               `json:"media_id"`
	EpisodeID     *string               `json:"episode_id"`
	Season        *int                  `json:"season"`
	Episode       *int                  `json:"episode"`
	Media         *catalog.MediaSummary `json:"media"`
	CreatedAt     time.Time             `json:"created_at"`
	StartedAt     *time.Time            `json:"started_at"`
	CompletedAt   *time.Time            `json:"completed_at"`
	LastWatchedAt *time.Time            `json:"last_watched_at"`
	KeepUntil     *time.Time            `json:"keep_until"`
	SpaceNeeded   *int64                `json:"space_needed_bytes"`
	Users         []UserRef             `json:"users,omitempty"`
}

// rate is the running job's speed and ETA.
func (s *Service) rate(d *row) (*float64, *int64) {
	s.mu.Lock()
	j := s.running[d.ID]
	s.mu.Unlock()
	if j == nil || d.Status != StatusDownloading {
		return nil, nil
	}
	r := j.rate()
	if r <= 0 {
		return nil, nil
	}
	eta := int64(float64(d.Size-j.done()) / r)
	return &r, &eta
}

// bytesDone prefers the running job's live counter over the stored checkpoint.
func (s *Service) bytesDone(d *row) int64 {
	if d.Status == StatusDone {
		return d.Size
	}
	s.mu.Lock()
	j := s.running[d.ID]
	s.mu.Unlock()
	if j != nil {
		return j.done()
	}
	return d.BytesDone
}

func (s *Service) present(d *row, keepDays int, mine bool) Download {
	out := Download{
		ID: d.ID, Status: d.Status, Error: d.Error, BytesDone: s.bytesDone(d), Size: d.Size, Pinned: d.Pinned, Mine: mine,
		InfoHash: d.InfoHash, FileIndex: d.FileIndex, FileName: path.Base(strings.ReplaceAll(d.FilePath, "\\", "/")),
		ReleaseTitle: d.ReleaseTitle, MediaID: d.MediaID, EpisodeID: d.EpisodeID, Season: d.Season, Episode: d.Episode,
		CreatedAt: d.CreatedAt, StartedAt: d.StartedAt, CompletedAt: d.CompletedAt, LastWatchedAt: d.LastWatchedAt,
		KeepUntil: keepUntil(s.candidate(d), keepDays),
	}
	if d.Status == StatusWaitingSpace {
		out.SpaceNeeded = d.SpaceNeeded
	}
	if d.Size > 0 {
		out.Progress = min(1, float64(out.BytesDone)/float64(d.Size))
	}
	out.RateBps, out.ETASeconds = s.rate(d)
	return out
}

func (s *Service) brief(d *row, keepDays int, mine bool) *playback.DownloadBrief {
	p := s.present(d, keepDays, mine)
	return &playback.DownloadBrief{ID: p.ID, Status: p.Status, Progress: p.Progress, BytesDone: p.BytesDone, Size: p.Size,
		RateBps: p.RateBps, ETASeconds: p.ETASeconds, CompletedAt: p.CompletedAt, KeepUntil: p.KeepUntil, Pinned: p.Pinned, Mine: mine}
}

// attachMedia fills media cards.
func (s *Service) attachMedia(ctx context.Context, items []Download, lang string) {
	if s.cat == nil || len(items) == 0 {
		return
	}
	seen := map[string]bool{}
	var ids []string
	for _, d := range items {
		if d.MediaID != nil && !seen[*d.MediaID] {
			seen[*d.MediaID] = true
			ids = append(ids, *d.MediaID)
		}
	}
	m, err := s.cat.SummariesByID(ctx, ids, lang)
	if err != nil {
		s.log.Warn("download media", "err", err)
		return
	}
	for i := range items {
		if items[i].MediaID != nil {
			if ms, ok := m[*items[i].MediaID]; ok {
				items[i].Media = &ms
			}
		}
	}
}

// ---- playback.Library ----

// LocalFile implements playback.Library.
func (s *Service) LocalFile(ctx context.Context, hash string, index int) (*playback.LocalFile, bool) {
	d, err := s.byKey(ctx, hash, index)
	if err != nil || d.Status != StatusDone {
		return nil, false
	}
	lf := &playback.LocalFile{DownloadID: d.ID, Path: s.finalPath(d), Size: d.Size}
	if d.CompletedAt != nil {
		lf.ModTime = *d.CompletedAt
	}
	return lf, true
}

// Brief implements playback.Library.
func (s *Service) Brief(ctx context.Context, userID, hash string, index int) *playback.DownloadBrief {
	d, err := s.byKey(ctx, hash, index)
	if err != nil {
		return nil
	}
	st, _ := s.settings(ctx)
	mine, _ := s.isRequester(ctx, d.ID, userID)
	return s.brief(d, st.KeepDays, mine)
}

// HasCompleted implements playback.Library.
func (s *Service) HasCompleted(ctx context.Context, hash string) bool {
	var ok bool
	_ = s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM downloads WHERE info_hash = $1 AND status = 'done')`, hash).Scan(&ok)
	return ok
}

// Watched implements playback.Library: last_watched_at, written at most
// every WatchedEvery per download.
func (s *Service) Watched(id string) {
	now := s.now()
	s.mu.Lock()
	if last, ok := s.watched[id]; ok && now.Sub(last) < s.t.WatchedEvery {
		s.mu.Unlock()
		return
	}
	s.watched[id] = now
	s.mu.Unlock()
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := s.pool.Exec(ctx, `UPDATE downloads SET last_watched_at = $2 WHERE id = $1`, id, now); err != nil {
			s.log.Warn("touch download", "download_id", id, "err", err)
		}
	}()
}

// ---- requesters ----

func (s *Service) isRequester(ctx context.Context, id, userID string) (bool, error) {
	if userID == "" {
		return false, nil
	}
	var ok bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM download_requests WHERE download_id = $1 AND user_id = $2)`, id, userID).Scan(&ok)
	return ok, err
}

func (s *Service) requesters(ctx context.Context, id string) []string {
	rows, err := s.pool.Query(ctx, `SELECT user_id FROM download_requests WHERE download_id = $1`, id)
	if err != nil {
		return nil
	}
	ids, _ := pgx.CollectRows(rows, pgx.RowTo[string])
	return ids
}

// ---- realtime ----

// notify sends download.updated to the requesters (status changes at once,
// progress at most every EventEvery). media is null in events.
func (s *Service) notify(ctx context.Context, d *row, statusChanged bool) {
	if s.hub == nil {
		return
	}
	now := s.now()
	s.mu.Lock()
	if last, ok := s.lastEvent[d.ID]; ok && !statusChanged && now.Sub(last) < s.t.EventEvery {
		s.mu.Unlock()
		return
	}
	s.lastEvent[d.ID] = now
	s.mu.Unlock()
	users := s.requesters(ctx, d.ID)
	if len(users) == 0 {
		return
	}
	st, _ := s.settings(ctx)
	p := s.present(d, st.KeepDays, true)
	b, _ := json.Marshal(p)
	s.hub.NotifyUsers(users, realtime.Envelope{Type: "download.updated", Payload: b})
}

func (s *Service) notifyRemoved(users []string, id string) {
	if s.hub == nil || len(users) == 0 {
		return
	}
	b, _ := json.Marshal(map[string]string{"id": id})
	s.hub.NotifyUsers(users, realtime.Envelope{Type: "download.removed", Payload: b})
	s.mu.Lock()
	delete(s.lastEvent, id)
	s.mu.Unlock()
}

// refresh re-reads a row and notifies.
func (s *Service) refresh(ctx context.Context, id string, statusChanged bool) {
	if d, err := s.get(ctx, id); err == nil {
		s.notify(ctx, d, statusChanged)
	}
}
