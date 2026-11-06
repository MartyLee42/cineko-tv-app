package downloads

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
	"martytv/api/internal/playback"
)

// Routes mounts /downloads (browser sessions, API tokens with read/write,
// and TVs acting as their owner).
func (s *Service) Routes(api fiber.Router) {
	g := api.Group("/downloads", requirePlayer())
	g.Get("", s.list)
	g.Post("", s.create)
	g.Get("/:id", s.getOne)
	g.Patch("/:id", s.patch)
	g.Delete("/:id", s.remove)
}

// AdminRoutes mounts /admin/storage and /admin/torrserver/torrents on the
// admin group.
func (s *Service) AdminRoutes(admin fiber.Router) {
	admin.Get("/storage", s.adminStorage)
	admin.Patch("/storage", s.adminUpdateStorage)
	admin.Get("/torrserver/torrents", s.adminTorrents)
	admin.Delete("/torrserver/torrents/:hash", s.adminRemoveTorrent)
}

func requirePlayer() fiber.Handler {
	return func(c fiber.Ctx) error {
		p := auth.PrincipalFrom(c)
		if p == nil {
			return httpx.Unauthorized()
		}
		if p.Kind == auth.KindToken {
			need := auth.ScopeWrite
			if m := c.Method(); m == fiber.MethodGet || m == fiber.MethodHead {
				need = auth.ScopeRead
			}
			if !p.HasScope(need) {
				return httpx.NewError(fiber.StatusForbidden, "insufficient_scope", "Token lacks the "+need+" scope.")
			}
		}
		return c.Next()
	}
}

// isAdmin: an admin acting as such (a TV never is; tokens need the admin scope).
func isAdmin(p *auth.Principal) bool {
	return p.Kind != auth.KindDevice && p.IsAdmin() && p.HasScope(auth.ScopeAdmin)
}

func lang(c fiber.Ctx) string {
	if c.Query("lang") == "en" {
		return "en"
	}
	return "ru"
}

func validUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil && len(s) == 36
}

func (s *Service) auditEvent(c fiber.Ctx, action, id string, meta map[string]any) {
	p := auth.PrincipalFrom(c)
	e := audit.Event{UserID: p.UserID, Action: action, TargetType: "download", TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: meta}
	if p.Kind == auth.KindDevice {
		e.DeviceID = p.DeviceID
	}
	s.audit.Record(c.Context(), e)
}

// ---- POST /downloads ----

type fileSpec struct {
	Index     int
	Path      string
	Size      int64
	EpisodeID *string
}

func (s *Service) create(c fiber.Ctx) error {
	var in struct {
		SourceID string `json:"source_id"`
		Season   bool   `json:"season"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if !validUUID(in.SourceID) {
		return httpx.Validation(map[string]string{"source_id": "Must be a UUID."})
	}
	p := auth.PrincipalFrom(c)
	ctx := c.Context()
	src, err := s.pb.SourceFor(ctx, p, in.SourceID)
	if errors.Is(err, playback.ErrSourceNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	if src.Kind == "online" {
		return httpx.NewError(fiber.StatusUnprocessableEntity, "not_a_torrent", "Online sources can't be downloaded.")
	}
	if src.Status != "ready" || src.FileIndex == nil || src.FileSize <= 0 {
		return httpx.NewError(fiber.StatusConflict, "source_not_ready", "The source has no file selected yet.")
	}
	if !s.ready() {
		return httpx.NewError(fiber.StatusServiceUnavailable, "library_unavailable", "The server has no writable download folder.")
	}

	files := []fileSpec{{Index: *src.FileIndex, Path: src.FilePath, Size: src.FileSize, EpisodeID: src.EpisodeID}}
	if in.Season {
		files = append(files, s.seasonFiles(ctx, src)...)
	}
	var out []Download
	st, _ := s.settings(ctx)
	for _, f := range files {
		d, created, err := s.upsert(ctx, src, f, p.UserID)
		if err != nil {
			return err
		}
		s.auditEvent(c, "downloads.created", d.ID, map[string]any{"info_hash": d.InfoHash, "file_index": d.FileIndex,
			"size": d.Size, "reused": !created, "source_id": src.ID})
		s.notify(ctx, d, true)
		out = append(out, s.present(d, st.KeepDays, true))
	}
	s.kick()
	s.attachMedia(ctx, out, lang(c))
	return c.Status(fiber.StatusCreated).JSON(httpx.List(out))
}

// seasonFiles: the other episode files of the source's season (season packs).
func (s *Service) seasonFiles(ctx context.Context, src *playback.SourceFile) []fileSpec {
	var season *int
	for _, f := range src.Files {
		if f.Index == *src.FileIndex {
			season = f.Season
		}
	}
	if season == nil {
		return nil
	}
	var out []fileSpec
	for _, f := range src.Files {
		if f.Index == *src.FileIndex || !f.IsVideo || f.Extra() || f.Season == nil || *f.Season != *season || f.Episode == nil || f.SizeBytes <= 0 {
			continue
		}
		fs := fileSpec{Index: f.Index, Path: f.Path, Size: f.SizeBytes}
		var epID string
		if err := s.pool.QueryRow(ctx, `SELECT id FROM episodes WHERE media_id = $1 AND season_number = $2 AND episode_number = $3`,
			src.MediaID, *f.Season, *f.Episode).Scan(&epID); err == nil {
			fs.EpisodeID = &epID
		}
		out = append(out, fs)
	}
	return out
}

// upsert creates the download (or reuses it, restarting a failed one) and
// records the caller as a requester.
func (s *Service) upsert(ctx context.Context, src *playback.SourceFile, f fileSpec, userID string) (*row, bool, error) {
	var id string
	var created bool
	err := s.pool.QueryRow(ctx, `INSERT INTO downloads (info_hash, file_index, file_path, size, media_id, episode_id, release_title, source_id, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (info_hash, file_index) DO UPDATE SET
			media_id = COALESCE(downloads.media_id, EXCLUDED.media_id), episode_id = COALESCE(downloads.episode_id, EXCLUDED.episode_id),
			source_id = COALESCE(downloads.source_id, EXCLUDED.source_id),
			status = CASE WHEN downloads.status = 'failed' THEN 'queued' ELSE downloads.status END,
			error = CASE WHEN downloads.status = 'failed' THEN NULL ELSE downloads.error END,
			updated_at = now()
		RETURNING id, xmax = 0`,
		src.InfoHash, f.Index, f.Path, f.Size, src.MediaID, f.EpisodeID, src.ReleaseTitle, src.ID, userID).Scan(&id, &created)
	if err != nil {
		return nil, false, err
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO download_requests (download_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, id, userID); err != nil {
		return nil, false, err
	}
	s.mu.Lock()
	delete(s.retryAt, id) // a new request retries at once
	s.mu.Unlock()
	d, err := s.get(ctx, id)
	return d, created, err
}

// ---- GET /downloads ----

var validStatus = map[string]bool{StatusQueued: true, StatusDownloading: true, StatusPaused: true, StatusDone: true, StatusFailed: true, StatusWaitingSpace: true}

func (s *Service) list(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	all := c.Query("all") == "true" || c.Query("all") == "1"
	if all && !isAdmin(p) {
		return httpx.Forbidden()
	}
	q := `SELECT ` + rowCols + rowFrom + ` WHERE TRUE`
	var args []any
	if !all {
		args = append(args, p.UserID)
		q += ` AND EXISTS (SELECT 1 FROM download_requests r WHERE r.download_id = d.id AND r.user_id = $1)`
	}
	if st := c.Query("status"); st != "" {
		if !validStatus[st] {
			return httpx.Validation(map[string]string{"status": "Unknown status."})
		}
		args = append(args, st)
		q += ` AND d.status = $` + itoa(len(args))
	}
	if m := c.Query("media_id"); m != "" {
		if !validUUID(m) {
			return httpx.Validation(map[string]string{"media_id": "Must be a UUID."})
		}
		args = append(args, m)
		q += ` AND d.media_id = $` + itoa(len(args))
	}
	q += ` ORDER BY d.created_at DESC LIMIT 1000`
	ctx := c.Context()
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return err
	}
	var ds []*row
	for rows.Next() {
		d, err := scanRow(rows)
		if err != nil {
			rows.Close()
			return err
		}
		ds = append(ds, d)
	}
	rows.Close()
	st, _ := s.settings(ctx)
	mine := s.mineSet(ctx, p.UserID)
	out := make([]Download, 0, len(ds))
	for _, d := range ds {
		out = append(out, s.present(d, st.KeepDays, mine[d.ID]))
	}
	if all {
		s.attachUsers(ctx, out)
	}
	s.attachMedia(ctx, out, lang(c))
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(httpx.List(out))
}

func itoa(n int) string { return strconv.Itoa(n) }

func (s *Service) mineSet(ctx context.Context, userID string) map[string]bool {
	out := map[string]bool{}
	rows, err := s.pool.Query(ctx, `SELECT download_id FROM download_requests WHERE user_id = $1`, userID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			out[id] = true
		}
	}
	return out
}

func (s *Service) attachUsers(ctx context.Context, items []Download) {
	rows, err := s.pool.Query(ctx, `SELECT r.download_id, u.id, u.username, u.display_name FROM download_requests r
		JOIN users u ON u.id = r.user_id ORDER BY r.created_at`)
	if err != nil {
		return
	}
	defer rows.Close()
	by := map[string][]UserRef{}
	for rows.Next() {
		var did string
		var u UserRef
		if rows.Scan(&did, &u.ID, &u.Username, &u.DisplayName) == nil {
			by[did] = append(by[did], u)
		}
	}
	for i := range items {
		items[i].Users = by[items[i].ID]
		if items[i].Users == nil {
			items[i].Users = []UserRef{}
		}
	}
}

// load returns a download the caller may see: a requester, or an admin.
func (s *Service) load(c fiber.Ctx) (*row, bool, error) {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return nil, false, err
	}
	p := auth.PrincipalFrom(c)
	d, err := s.get(c.Context(), id)
	if errors.Is(err, errNotFound) {
		return nil, false, httpx.NotFound()
	}
	if err != nil {
		return nil, false, err
	}
	mine, err := s.isRequester(c.Context(), d.ID, p.UserID)
	if err != nil {
		return nil, false, err
	}
	if !mine && !isAdmin(p) {
		return nil, false, httpx.NotFound()
	}
	return d, mine, nil
}

func (s *Service) respond(c fiber.Ctx, d *row, mine bool) error {
	st, _ := s.settings(c.Context())
	out := []Download{s.present(d, st.KeepDays, mine)}
	s.attachMedia(c.Context(), out, lang(c))
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(out[0])
}

func (s *Service) getOne(c fiber.Ctx) error {
	d, mine, err := s.load(c)
	if err != nil {
		return err
	}
	return s.respond(c, d, mine)
}

// ---- PATCH /downloads/{id} ----

func (s *Service) patch(c fiber.Ctx) error {
	var in struct {
		Pinned *bool `json:"pinned"`
		Paused *bool `json:"paused"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if in.Pinned == nil && in.Paused == nil {
		return httpx.Validation(map[string]string{"pinned": "Set pinned and/or paused."})
	}
	d, mine, err := s.load(c)
	if err != nil {
		return err
	}
	ctx := c.Context()
	if in.Pinned != nil && *in.Pinned != d.Pinned {
		if _, err := s.pool.Exec(ctx, `UPDATE downloads SET pinned = $2, updated_at = now() WHERE id = $1`, d.ID, *in.Pinned); err != nil {
			return err
		}
		s.auditEvent(c, "downloads.pinned", d.ID, map[string]any{"pinned": *in.Pinned})
	}
	if in.Paused != nil {
		switch {
		case *in.Paused && (d.Status == StatusQueued || d.Status == StatusDownloading || d.Status == StatusWaitingSpace):
			s.stopJob(d.ID, "paused")
			if _, err := s.pool.Exec(ctx, `UPDATE downloads SET status = 'paused', updated_at = now() WHERE id = $1 AND status <> 'done'`, d.ID); err != nil {
				return err
			}
		case !*in.Paused && (d.Status == StatusPaused || d.Status == StatusFailed):
			if _, err := s.pool.Exec(ctx, `UPDATE downloads SET status = 'queued', error = NULL, updated_at = now() WHERE id = $1`, d.ID); err != nil {
				return err
			}
			s.mu.Lock()
			delete(s.retryAt, d.ID)
			delete(s.failures, d.ID)
			s.mu.Unlock()
			s.kick()
		}
	}
	if d, err = s.get(ctx, d.ID); err != nil {
		return err
	}
	s.notify(ctx, d, true)
	return s.respond(c, d, mine)
}

// ---- DELETE /downloads/{id} ----

func (s *Service) remove(c fiber.Ctx) error {
	d, mine, err := s.load(c)
	if err != nil {
		return err
	}
	ctx := c.Context()
	p := auth.PrincipalFrom(c)
	deleteFile := isAdmin(p)
	if !deleteFile && mine {
		if _, err := s.pool.Exec(ctx, `DELETE FROM download_requests WHERE download_id = $1 AND user_id = $2`, d.ID, p.UserID); err != nil {
			return err
		}
		var left int
		if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM download_requests WHERE download_id = $1`, d.ID).Scan(&left); err != nil {
			return err
		}
		deleteFile = left == 0
		if !deleteFile {
			s.notifyRemoved([]string{p.UserID}, d.ID)
		}
	}
	if deleteFile {
		s.deleteDownload(context.Background(), d)
		if mine { // their request row is already gone: tell them too
			s.notifyRemoved([]string{p.UserID}, d.ID)
		}
	}
	s.auditEvent(c, "downloads.deleted", d.ID, map[string]any{"info_hash": d.InfoHash, "file_index": d.FileIndex, "size": d.Size,
		"file_deleted": deleteFile, "as_admin": isAdmin(p) && !mine})
	return c.SendStatus(fiber.StatusNoContent)
}

// ---- admin storage ----

// StorageStatus is GET /admin/storage (contract: StorageStatus).
type StorageStatus struct {
	OK               bool           `json:"ok"`
	DiskTotalBytes   int64          `json:"disk_total_bytes"`
	DiskFreeBytes    int64          `json:"disk_free_bytes"`
	LibraryUsedBytes int64          `json:"library_used_bytes"`
	ReserveBytes     int64          `json:"reserve_bytes"`
	AvailableBytes   int64          `json:"available_bytes"`
	Settings         Settings       `json:"settings"`
	Counts           map[string]int `json:"counts"`
	MaxJobs          int            `json:"max_jobs"`
}

// Storage reports disk and library usage.
func (s *Service) Storage(ctx context.Context) (*StorageStatus, error) {
	st, err := s.settings(ctx)
	if err != nil {
		return nil, err
	}
	out := &StorageStatus{OK: s.ready(), Settings: st, ReserveBytes: st.reserveBytes(), MaxJobs: s.jobs,
		Counts: map[string]int{StatusQueued: 0, StatusDownloading: 0, StatusPaused: 0, StatusDone: 0, StatusFailed: 0, StatusWaitingSpace: 0}}
	disk, err := s.DiskStats(s.dir)
	if err != nil {
		out.OK = false
	} else {
		out.DiskTotalBytes, out.DiskFreeBytes = disk.Total, disk.Free
	}
	if out.LibraryUsedBytes, err = s.libraryUsed(ctx); err != nil {
		return nil, err
	}
	if out.OK {
		out.AvailableBytes = max(0, available(disk, st, out.LibraryUsedBytes, s.othersRemaining("")))
	}
	rows, err := s.pool.Query(ctx, `SELECT status, count(*) FROM downloads GROUP BY status`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		var n int
		if rows.Scan(&k, &n) == nil {
			out.Counts[k] = n
		}
	}
	return out, nil
}

func (s *Service) adminStorage(c fiber.Ctx) error {
	out, err := s.Storage(c.Context())
	if err != nil {
		return err
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(out)
}

func (s *Service) adminUpdateStorage(c fiber.Ctx) error {
	var raw map[string]json.RawMessage
	if err := httpx.BindJSON(c, &raw); err != nil {
		return err
	}
	ctx := c.Context()
	st, err := s.settings(ctx)
	if err != nil {
		return err
	}
	fields := map[string]string{}
	meta := map[string]any{}
	for k, v := range raw {
		switch k {
		case "reserve_gb":
			var f float64
			if json.Unmarshal(v, &f) != nil || f < 1 || f > 10000 {
				fields[k] = "A number of GB, 1…10000."
				continue
			}
			st.ReserveGB = f
			meta[k] = f
		case "max_library_gb":
			if strings.TrimSpace(string(v)) == "null" {
				st.MaxLibraryGB = nil
				meta[k] = nil
				continue
			}
			var f float64
			if json.Unmarshal(v, &f) != nil || f < 1 || f > 100000 {
				fields[k] = "A number of GB, 1…100000, or null for no cap."
				continue
			}
			st.MaxLibraryGB = &f
			meta[k] = f
		case "keep_days":
			var n int
			if json.Unmarshal(v, &n) != nil || n < 1 || n > 3650 {
				fields[k] = "Whole days, 1…3650."
				continue
			}
			st.KeepDays = n
			meta[k] = n
		default:
			fields[k] = "Unknown field."
		}
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	p := auth.PrincipalFrom(c)
	if _, err := s.pool.Exec(ctx, `UPDATE library_settings SET reserve_gb = $1, max_library_gb = $2, keep_days = $3, updated_at = now(), updated_by = $4
		WHERE id = 1`, st.ReserveGB, st.MaxLibraryGB, st.KeepDays, p.UserID); err != nil {
		return err
	}
	s.audit.Record(ctx, audit.Event{UserID: p.UserID, Action: "storage.updated", TargetType: "library_settings", TargetID: "1",
		IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: meta})
	s.kick()
	return s.adminStorage(c)
}
