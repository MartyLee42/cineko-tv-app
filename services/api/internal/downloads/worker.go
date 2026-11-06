package downloads

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"martytv/api/internal/audit"
)

// job is a running download.
type job struct {
	id     string
	size   int64
	cancel context.CancelFunc
	exited chan struct{}
	bytes  atomic.Int64
	reason atomic.Value // why it was stopped: paused | deleted | shutdown

	mu     sync.Mutex
	rateV  float64
	lastAt time.Time
	lastB  int64
}

func (j *job) done() int64 { return j.bytes.Load() }

func (j *job) rate() float64 {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.rateV
}

// sample updates the speed (exponential moving average).
func (j *job) sample(now time.Time) {
	j.mu.Lock()
	defer j.mu.Unlock()
	b := j.bytes.Load()
	if !j.lastAt.IsZero() {
		if dt := now.Sub(j.lastAt).Seconds(); dt > 0 {
			r := float64(b-j.lastB) / dt
			if j.rateV == 0 {
				j.rateV = r
			} else {
				j.rateV = 0.7*j.rateV + 0.3*r
			}
		}
	}
	j.lastAt, j.lastB = now, b
}

func (j *job) stopReason() string {
	r, _ := j.reason.Load().(string)
	return r
}

// Run schedules downloads until ctx ends: resumes interrupted ones, starts
// queued ones (≤ DOWNLOAD_MAX_JOBS), re-checks waiting_space and retries,
// and runs the hourly janitor.
func (s *Service) Run(ctx context.Context) {
	if _, err := s.pool.Exec(ctx, `UPDATE downloads SET status = 'queued', updated_at = now() WHERE status = 'downloading'`); err != nil && ctx.Err() == nil {
		s.log.Warn("resume downloads", "err", err)
	}
	s.janitor(ctx)
	tick := time.NewTicker(s.t.Tick)
	defer tick.Stop()
	jan := time.NewTicker(s.t.Janitor)
	defer jan.Stop()
	for {
		s.schedule(ctx)
		select {
		case <-ctx.Done():
			s.stopAll("shutdown")
			return
		case <-s.wake:
		case <-tick.C:
		case <-jan.C:
			s.janitor(ctx)
		}
	}
}

func (s *Service) stopAll(reason string) {
	s.mu.Lock()
	var js []*job
	for _, j := range s.running {
		js = append(js, j)
	}
	s.mu.Unlock()
	for _, j := range js {
		s.stopJob(j.id, reason)
	}
}

// stopJob cancels a running job and waits (≤ 15 s) until it stopped writing.
func (s *Service) stopJob(id, reason string) {
	s.mu.Lock()
	j := s.running[id]
	s.mu.Unlock()
	if j == nil {
		return
	}
	j.reason.Store(reason)
	j.cancel()
	select {
	case <-j.exited:
	case <-time.After(15 * time.Second):
		s.log.Warn("download job did not stop", "download_id", id)
	}
}

func (s *Service) schedule(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	s.mu.Lock()
	free := s.jobs - len(s.running)
	s.mu.Unlock()
	if free <= 0 {
		return
	}
	rows, err := s.pool.Query(ctx, `SELECT `+rowCols+rowFrom+` WHERE d.status IN ('queued', 'waiting_space')
		ORDER BY d.status = 'waiting_space', d.created_at LIMIT 100`)
	if err != nil {
		if ctx.Err() == nil {
			s.log.Warn("schedule downloads", "err", err)
		}
		return
	}
	var todo []*row
	for rows.Next() {
		d, err := scanRow(rows)
		if err == nil {
			todo = append(todo, d)
		}
	}
	rows.Close()
	if len(todo) > 0 && !s.ready() {
		s.log.Warn("library directory is not writable; downloads wait", "dir", s.dir)
		return
	}
	now := s.now()
	for _, d := range todo {
		if free <= 0 {
			return
		}
		s.mu.Lock()
		_, busy := s.running[d.ID]
		at := s.retryAt[d.ID]
		s.mu.Unlock()
		if busy || now.Before(at) {
			continue
		}
		if s.start(ctx, d) {
			free--
		}
	}
}

// othersRemaining is what running downloads still have to write.
func (s *Service) othersRemaining(except string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	for id, j := range s.running {
		if id != except {
			n += max(0, j.size-j.done())
		}
	}
	return n
}

// space reports how many more bytes are needed for remaining (≤ 0: fits).
func (s *Service) space(ctx context.Context, d *row, remaining int64) (need int64, st Settings, err error) {
	st, err = s.settings(ctx)
	if err != nil {
		return 0, st, err
	}
	disk, err := s.DiskStats(s.dir)
	if err != nil {
		return 0, st, err
	}
	used, err := s.libraryUsed(ctx)
	if err != nil {
		return 0, st, err
	}
	return remaining - available(disk, st, used, s.othersRemaining(d.ID)), st, nil
}

// start checks space (evicting if allowed) and launches the job.
func (s *Service) start(ctx context.Context, d *row) bool {
	remaining := d.Size - s.onDisk(d)
	need, st, err := s.space(ctx, d, remaining)
	if err != nil {
		s.log.Warn("disk space check", "download_id", d.ID, "err", err)
		return false
	}
	if need > 0 {
		if _, ok := s.evict(ctx, need, st, d.ID); !ok {
			if d.Status != StatusWaitingSpace || d.SpaceNeeded == nil || *d.SpaceNeeded != need {
				_, _ = s.pool.Exec(ctx, `UPDATE downloads SET status = 'waiting_space', error = $2, space_needed = $3, updated_at = now()
					WHERE id = $1 AND status IN ('queued', 'waiting_space')`, d.ID, ErrInsufficientSpace, need)
				if d.Status != StatusWaitingSpace {
					s.log.Info("download waits for space", "download_id", d.ID, "need", need)
				}
				s.refresh(ctx, d.ID, d.Status != StatusWaitingSpace)
			}
			return false
		}
	}
	tag, err := s.pool.Exec(ctx, `UPDATE downloads SET status = 'downloading', error = NULL, space_needed = NULL,
		started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 AND status IN ('queued', 'waiting_space')`, d.ID)
	if err != nil || tag.RowsAffected() == 0 {
		return false
	}
	jctx, cancel := context.WithCancel(context.Background())
	j := &job{id: d.ID, size: d.Size, cancel: cancel, exited: make(chan struct{})}
	j.bytes.Store(s.onDisk(d))
	s.mu.Lock()
	s.running[d.ID] = j
	s.mu.Unlock()
	s.bg.Add(1)
	go s.runJob(jctx, j, d)
	s.refresh(ctx, d.ID, true)
	return true
}

func (s *Service) backoff(failures int) time.Duration {
	d := s.t.BackoffBase
	for i := 1; i < failures && d < s.t.BackoffMax; i++ {
		d *= 2
	}
	return min(d, s.t.BackoffMax)
}

func (s *Service) runJob(ctx context.Context, j *job, d *row) {
	defer s.bg.Done()
	defer func() {
		s.mu.Lock()
		delete(s.running, d.ID)
		s.mu.Unlock()
		close(j.exited)
		j.cancel()
		s.kick()
	}()
	log := s.log.With("download_id", d.ID)
	bg := context.Background()
	startBytes := j.done()

	// Live progress events while running.
	tickDone := make(chan struct{})
	defer close(tickDone)
	go func() {
		t := time.NewTicker(s.t.EventEvery)
		defer t.Stop()
		for {
			select {
			case <-tickDone:
				return
			case now := <-t.C:
				j.sample(now)
				s.refresh(bg, d.ID, false)
			}
		}
	}()

	var err error
	if err = os.MkdirAll(s.hashDir(d.InfoHash), 0o750); err != nil {
		err = &writeError{err}
	} else if err = s.pb.EnsureTorrent(ctx, d.InfoHash); err == nil {
		open := func(ctx context.Context, off int64) (*http.Response, error) {
			return s.ts.Stream(ctx, d.InfoHash, d.FileIndex, "bytes="+strconv.FormatInt(off, 10)+"-", "")
		}
		_, err = transfer(ctx, open, s.partPath(d), d.Size, transferOpts{
			CheckpointBytes: s.t.CheckpointBytes, CheckpointEvery: s.t.CheckpointEvery, Idle: s.t.Idle, Progress: &j.bytes,
			OnCheckpoint: func(done int64) error {
				_, _ = s.pool.Exec(bg, `UPDATE downloads SET bytes_done = $2, updated_at = now() WHERE id = $1`, d.ID, done)
				if st, err := s.settings(bg); err == nil {
					if disk, err := s.DiskStats(s.dir); err == nil && disk.Free < st.reserveBytes() {
						return errNoSpace
					}
				}
				return nil
			},
		})
	}
	done := j.done()

	if reason := j.stopReason(); reason != "" {
		// Paused / deleted / shutdown: the caller owns the status.
		if reason != "deleted" {
			_, _ = s.pool.Exec(bg, `UPDATE downloads SET bytes_done = $2, updated_at = now() WHERE id = $1`, d.ID, done)
		}
		return
	}

	var wErr *writeError
	switch {
	case err == nil:
		if err := s.finish(d); err != nil {
			log.Error("finish download", "err", err)
			s.fail(bg, d.ID, ErrWrite)
			return
		}
		s.mu.Lock()
		delete(s.failures, d.ID)
		delete(s.retryAt, d.ID)
		s.mu.Unlock()
		_, _ = s.pool.Exec(bg, `UPDATE downloads SET status = 'done', error = NULL, bytes_done = size, completed_at = now(), updated_at = now()
			WHERE id = $1`, d.ID)
		log.Info("download done", "size", d.Size)
		s.refresh(bg, d.ID, true)
	case errors.Is(err, errSizeMismatch):
		log.Warn("download size mismatch", "expected", d.Size, "at", done)
		_ = os.Remove(s.partPath(d))
		_, _ = s.pool.Exec(bg, `UPDATE downloads SET status = 'failed', error = $2, bytes_done = 0, updated_at = now() WHERE id = $1`, d.ID, ErrSizeMismatch)
		s.refresh(bg, d.ID, true)
	case errors.Is(err, errNoSpace) || errors.Is(err, syscall.ENOSPC):
		log.Warn("download paused: disk below the reserve")
		_, _ = s.pool.Exec(bg, `UPDATE downloads SET status = 'waiting_space', error = $2, bytes_done = $3, updated_at = now() WHERE id = $1`,
			d.ID, ErrInsufficientSpace, done)
		s.mu.Lock()
		s.retryAt[d.ID] = s.now().Add(s.t.Tick)
		s.mu.Unlock()
		s.refresh(bg, d.ID, true)
	case errors.As(err, &wErr):
		log.Error("download write failed", "err", err)
		s.fail(bg, d.ID, ErrWrite)
	default:
		s.mu.Lock()
		if done > startBytes {
			s.failures[d.ID] = 1
		} else {
			s.failures[d.ID]++
		}
		n := s.failures[d.ID]
		wait := s.backoff(n)
		s.retryAt[d.ID] = s.now().Add(wait)
		s.mu.Unlock()
		if n >= s.t.MaxFailures {
			log.Warn("download failed", "err", err, "failures", n)
			s.fail(bg, d.ID, ErrUpstream)
			return
		}
		log.Info("download interrupted; retrying", "err", err, "at", done, "retry_in", wait)
		_, _ = s.pool.Exec(bg, `UPDATE downloads SET status = 'queued', error = $2, bytes_done = $3, updated_at = now() WHERE id = $1 AND status = 'downloading'`,
			d.ID, ErrUpstream, done)
		s.refresh(bg, d.ID, true)
	}
}

func (s *Service) fail(ctx context.Context, id, code string) {
	_, _ = s.pool.Exec(ctx, `UPDATE downloads SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, id, code)
	s.mu.Lock()
	delete(s.failures, id)
	delete(s.retryAt, id)
	s.mu.Unlock()
	s.refresh(ctx, id, true)
}

// finish verifies the part file and renames it to its final name.
func (s *Service) finish(d *row) error {
	part := s.partPath(d)
	st, err := os.Stat(part)
	if err != nil {
		return err
	}
	if st.Size() != d.Size {
		return errSizeMismatch
	}
	if err := os.Rename(part, s.finalPath(d)); err != nil {
		return err
	}
	if dir, err := os.Open(s.hashDir(d.InfoHash)); err == nil { // persist the rename
		_ = dir.Sync()
		dir.Close()
	}
	return nil
}

// evict deletes evictable completed downloads (planEviction) to free need
// bytes. ok=false: not enough could be freed, nothing was deleted.
func (s *Service) evict(ctx context.Context, need int64, st Settings, forID string) (int64, bool) {
	rows, err := s.pool.Query(ctx, `SELECT `+rowCols+rowFrom+` WHERE d.status = 'done'`)
	if err != nil {
		return 0, false
	}
	byID := map[string]*row{}
	var cands []candidate
	for rows.Next() {
		d, err := scanRow(rows)
		if err == nil {
			byID[d.ID] = d
			cands = append(cands, s.candidate(d))
		}
	}
	rows.Close()
	victims, freed := planEviction(cands, need, s.now(), st.KeepDays)
	if victims == nil {
		return freed, false
	}
	for _, v := range victims {
		d := byID[v.ID]
		s.deleteDownload(ctx, d)
		s.log.Info("download evicted", "download_id", d.ID, "size", d.Size, "for", forID)
		s.audit.Record(ctx, audit.Event{Action: "downloads.evicted", TargetType: "download", TargetID: d.ID,
			Metadata: map[string]any{"info_hash": d.InfoHash, "file_index": d.FileIndex, "size": d.Size, "for_download": forID,
				"last_used": s.candidate(d).lastUse().UTC().Format(time.RFC3339)}})
	}
	return freed, true
}

// deleteDownload stops, deletes the row and the files, and tells requesters.
func (s *Service) deleteDownload(ctx context.Context, d *row) {
	s.stopJob(d.ID, "deleted")
	users := s.requesters(ctx, d.ID)
	if _, err := s.pool.Exec(ctx, `DELETE FROM downloads WHERE id = $1`, d.ID); err != nil {
		s.log.Warn("delete download", "download_id", d.ID, "err", err)
		return
	}
	s.removeFiles(d)
	s.mu.Lock()
	delete(s.failures, d.ID)
	delete(s.retryAt, d.ID)
	delete(s.watched, d.ID)
	s.mu.Unlock()
	s.notifyRemoved(users, d.ID)
	s.kick()
}

// janitor (hourly): frees space when the disk is below the reserve or the
// library over its cap (evicting only what the rules allow), re-queues
// completed downloads whose file vanished, and wakes waiting downloads.
func (s *Service) janitor(ctx context.Context) {
	defer s.kick()
	if !s.ready() {
		return
	}
	st, err := s.settings(ctx)
	if err != nil {
		return
	}
	disk, err := s.DiskStats(s.dir)
	if err != nil {
		s.log.Warn("disk stats", "err", err)
		return
	}
	used, _ := s.libraryUsed(ctx)
	deficit := st.reserveBytes() - disk.Free
	if lim := st.maxLibraryBytes(); lim > 0 {
		deficit = max(deficit, used-lim)
	}
	if deficit > 0 {
		if freed, ok := s.evict(ctx, deficit, st, ""); !ok {
			s.log.Warn("low disk space; nothing old enough to remove", "deficit", deficit, "freeable", freed)
		}
	}
	rows, err := s.pool.Query(ctx, `SELECT `+rowCols+rowFrom+` WHERE d.status = 'done'`)
	if err != nil {
		return
	}
	var missing []*row
	for rows.Next() {
		if d, err := scanRow(rows); err == nil {
			if fi, err := os.Stat(s.finalPath(d)); err != nil || fi.Size() != d.Size {
				missing = append(missing, d)
			}
		}
	}
	rows.Close()
	for _, d := range missing {
		s.log.Warn("downloaded file missing; downloading again", "download_id", d.ID)
		_, _ = s.pool.Exec(ctx, `UPDATE downloads SET status = 'queued', bytes_done = 0, completed_at = NULL, updated_at = now() WHERE id = $1`, d.ID)
		s.refresh(ctx, d.ID, true)
	}
}
