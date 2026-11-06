package main

// HLS compat sessions, for Safari / iOS: AVFoundation doesn't play a
// progressive MP4 without byte ranges (the /v1/remux stream), but it plays
// fMP4 HLS. ffmpeg writes an EVENT playlist (video copied, audio → AAC, like
// remux) into a per-session directory; the API relays the playlist and the
// finished files, which are served with Range (http.ServeContent).
//
//	POST /v1/hls                      signed job, kind "hls" → {"session": id, "start": K}
//	GET|HEAD /v1/hls/{id}/{file}?owner=<job owner>&exp=<unix>
//	    X-Job-Signature: hex(HMAC(key, "hls-file\n"+id+"\n"+file+"\n"+owner+"\n"+exp))
//	    file = index.m3u8 | init.mp4 | seg<N>.m4s
//
// Sessions are keyed by (owner, input, audio, channels, hvc1, keyframe start)
// and reused while intact. A session holds a remux slot (Config.MaxJobs)
// while ffmpeg runs. Disk use is bounded: ffmpeg is paused (SIGSTOP) once it
// is HLSAhead past the last requested segment, segments more than
// HLSKeepBehind behind it (or past HLSMaxBytes) are deleted, and a session is
// removed after HLSIdle without any request / HLSMediaIdle without a media
// request (a paused player that only polls the playlist), and on restart.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// hlsReadySegments: POST /v1/hls answers once this many segments exist
	// (or the stream ended), so the player's first playlist has a few.
	hlsReadySegments = 3
	hlsDirPrefix     = "hls-"
)

var (
	segName      = regexp.MustCompile(`^seg(\d{1,6})\.m4s$`)
	sessionIDPat = regexp.MustCompile(`^[0-9a-f]{32}$`)
	errBusy      = errors.New("busy")
)

// FileSignature is the X-Job-Signature of GET /v1/hls/{id}/{file}.
func FileSignature(key []byte, id, file, owner string, exp int64) string {
	return Sign(key, []byte("hls-file\n"+id+"\n"+file+"\n"+owner+"\n"+strconv.FormatInt(exp, 10)))
}

type hlsSeg struct {
	start, dur float64
	size       int64
	gone       bool
}

type hlsSession struct {
	id, key, owner, dir string
	start               float64
	job                 *Job
	cancel              context.CancelFunc
	pid                 int
	stderr              *limitedBuffer
	created             time.Time
	done                chan struct{} // closed when ffmpeg has exited

	mu         sync.Mutex
	lastAccess time.Time
	lastMedia  time.Time
	lastSeg    int // most recently requested segment, -1 = none
	stopped    bool
	exited     bool
	closed     bool
	exitErr    error
	segs       []hlsSeg
	ended      bool // #EXT-X-ENDLIST
	trimmed    bool // early segments deleted: not reusable from the start
	plMod      time.Time
	plSize     int64
}

type hlsManager struct {
	mu    sync.Mutex
	byID  map[string]*hlsSession
	byKey map[string]*hlsSession
}

func newHLSManager() *hlsManager {
	return &hlsManager{byID: map[string]*hlsSession{}, byKey: map[string]*hlsSession{}}
}

func (m *hlsManager) list() []*hlsSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*hlsSession, 0, len(m.byID))
	for _, s := range m.byID {
		out = append(out, s)
	}
	return out
}

func (m *hlsManager) get(id string) *hlsSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.byID[id]
}

func hlsKey(j *Job, start float64) string {
	audio := -1
	if j.Audio != nil {
		audio = *j.Audio
	}
	h := sha256.Sum256([]byte(strings.Join([]string{
		j.Owner, j.Input, strconv.Itoa(audio), strconv.FormatBool(j.AudioCopy), strconv.Itoa(j.Channels), strconv.FormatBool(j.HVC1), j.Video, fmtSeconds(start),
	}, "\x00")))
	return hex.EncodeToString(h[:])
}

// cleanHLSDir removes sessions left by a previous process.
func cleanHLSDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), hlsDirPrefix) {
			_ = os.RemoveAll(filepath.Join(dir, e.Name()))
		}
	}
	return nil
}

// ---------------------------------------------------------------- handlers

func (s *Server) hlsStart(w http.ResponseWriter, r *http.Request) {
	j := s.readJob(w, r, KindHLS)
	if j == nil {
		return
	}
	if s.hlsDirErr != nil {
		writeError(w, http.StatusInternalServerError, "internal", "HLS output directory is unavailable.")
		return
	}
	start := s.resolveStart(r.Context(), j)
	sess, fresh, err := s.hlsSession(r.Context(), j, start)
	if errors.Is(err, errBusy) {
		s.busy(w, KindHLS)
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "Could not start the converter.")
		return
	}
	switch s.waitReady(r.Context(), sess) {
	case readyOK:
	case readyGone:
		return // the API gave up; the janitor removes the session if unused
	default:
		sess.mu.Lock()
		exited := sess.exited
		sess.mu.Unlock()
		reason := "no_output"
		if !exited {
			reason = "start_timeout"
		}
		s.log.Warn("hls session failed before output", "reason", reason, "session", sess.id, "fresh", fresh,
			"stderr", sanitize(sess.stderrString(), j))
		s.closeHLS(sess, reason)
		writeError(w, http.StatusBadGateway, "stream_unavailable", "The file could not be opened or converted.")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Stream-Start", fmtSeconds(start))
	_ = json.NewEncoder(w).Encode(map[string]any{"session": sess.id, "start": start})
}

func (s *Server) hlsFile(w http.ResponseWriter, r *http.Request) {
	id, file := r.PathValue("id"), r.PathValue("file")
	q := r.URL.Query()
	owner := q.Get("owner")
	exp, err := strconv.ParseInt(q.Get("exp"), 10, 64)
	want, herr := hex.DecodeString(r.Header.Get("X-Job-Signature"))
	if err != nil || herr != nil || !hmac.Equal(want, mustHex(FileSignature(s.cfg.Key, id, file, owner, exp))) {
		s.log.Warn("hls file refused", "reason", "bad_signature")
		writeError(w, http.StatusForbidden, "bad_signature", "Request signature is invalid.")
		return
	}
	now := time.Now()
	if exp < now.Unix() {
		writeError(w, http.StatusForbidden, "job_expired", "Request has expired.")
		return
	}
	if exp > now.Add(maxExpiry).Unix() || !sessionIDPat.MatchString(id) {
		writeError(w, http.StatusBadRequest, "bad_job", "Request is invalid.")
		return
	}
	sess := s.hls.get(id)
	if sess == nil || sess.owner != owner {
		writeError(w, http.StatusNotFound, "hls_session_gone", "This conversion has ended; start the stream again.")
		return
	}
	switch {
	case file == hlsPlaylist:
		sess.touch(false)
		if sess.failed() {
			s.closeHLS(sess, "ffmpeg_error")
			writeError(w, http.StatusNotFound, "hls_session_gone", "This conversion has ended; start the stream again.")
			return
		}
		b, err := os.ReadFile(filepath.Join(sess.dir, hlsPlaylist))
		if err != nil {
			writeError(w, http.StatusNotFound, "hls_session_gone", "This conversion has ended; start the stream again.")
			return
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Length", strconv.Itoa(len(b)))
		if r.Method != http.MethodHead {
			_, _ = w.Write(b)
		}
	case file == hlsInit:
		sess.touch(true)
		s.serveHLSFile(w, r, sess, hlsInit, -1)
	default:
		m := segName.FindStringSubmatch(file)
		if m == nil {
			writeError(w, http.StatusNotFound, "not_found", "No such file.")
			return
		}
		n, _ := strconv.Atoi(m[1])
		sess.touch(true)
		sess.requested(n)
		sess.maintain(s.cfg) // resume ffmpeg if it was paused
		s.serveHLSFile(w, r, sess, file, n)
	}
}

// serveHLSFile serves a finished file with Range; a segment that isn't
// written yet is waited for while ffmpeg runs.
func (s *Server) serveHLSFile(w http.ResponseWriter, r *http.Request, sess *hlsSession, name string, n int) {
	path := filepath.Join(sess.dir, name)
	deadline := time.Now().Add(s.cfg.HLSSegmentWait)
	for {
		f, err := os.Open(path)
		if err == nil {
			defer f.Close()
			fi, err := f.Stat()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal", "Could not read the file.")
				return
			}
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("Cache-Control", "no-store")
			http.ServeContent(w, r, name, fi.ModTime(), f)
			return
		}
		if !sess.mayAppear(n) || time.Now().After(deadline) {
			writeError(w, http.StatusNotFound, "segment_unavailable", "This part of the stream is not available.")
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-sess.done:
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func mustHex(s string) []byte {
	b, _ := hex.DecodeString(s)
	return b
}

// ---------------------------------------------------------------- lifecycle

// hlsSession returns a reusable session for the job, or starts one (fresh).
func (s *Server) hlsSession(ctx context.Context, j *Job, start float64) (*hlsSession, bool, error) {
	key := hlsKey(j, start)
	if old := s.reusable(key); old != nil {
		return old, false, nil
	}
	if !s.acquireJob(ctx) {
		return nil, false, errBusy
	}
	sess, err := s.startHLS(j, start, key)
	if err != nil {
		<-s.jobs
		return nil, false, err
	}
	s.hls.mu.Lock()
	if other := s.hls.byKey[key]; other != nil && other.reusable() {
		// Started concurrently by another request: use that one.
		s.hls.mu.Unlock()
		s.closeHLS(sess, "duplicate")
		other.touch(false)
		return other, false, nil
	}
	s.hls.byID[sess.id], s.hls.byKey[key] = sess, sess
	var lru *hlsSession
	if len(s.hls.byID) > s.maxHLSSessions() {
		for _, o := range s.hls.byID {
			if o != sess && (lru == nil || o.accessed().Before(lru.accessed())) {
				lru = o
			}
		}
	}
	s.hls.mu.Unlock()
	if lru != nil {
		s.closeHLS(lru, "session_limit")
	}
	return sess, true, nil
}

func (s *Server) maxHLSSessions() int { return 2 * cap(s.jobs) }

func (s *Server) reusable(key string) *hlsSession {
	s.hls.mu.Lock()
	old := s.hls.byKey[key]
	s.hls.mu.Unlock()
	if old != nil && old.reusable() {
		old.touch(false)
		return old
	}
	return nil
}

// acquireJob takes a remux slot; when none is free, an HLS session nobody
// asked anything for a while gives up its slot first.
func (s *Server) acquireJob(ctx context.Context) bool {
	select {
	case s.jobs <- struct{}{}:
		return true
	default:
	}
	var victim *hlsSession
	for _, o := range s.hls.list() {
		if o.running() && time.Since(o.accessed()) > s.cfg.HLSEvictAfter && (victim == nil || o.accessed().Before(victim.accessed())) {
			victim = o
		}
	}
	if victim != nil {
		s.closeHLS(victim, "evicted")
	}
	return s.acquire(ctx, s.jobs, s.cfg.SlotWait)
}

// startHLS runs ffmpeg for a new session; the caller holds a slot, released
// when ffmpeg exits.
func (s *Server) startHLS(j *Job, start float64, key string) (*hlsSession, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp(s.cfg.HLSDir, hlsDirPrefix)
	if err != nil {
		s.log.Error("hls dir", "err", err)
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.MaxDuration)
	cmd := s.command(ctx, s.cfg.FFmpeg, HLSArgs(j, start))
	cmd.Dir = dir
	stderr := &limitedBuffer{b: &bytes.Buffer{}, max: 8192, tail: true}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		cancel()
		_ = os.RemoveAll(dir)
		s.failed.Add(1)
		s.log.Error("ffmpeg start failed", "kind", KindHLS, "err", err)
		return nil, err
	}
	s.started.Add(1)
	now := time.Now()
	sess := &hlsSession{
		id: hex.EncodeToString(raw[:]), key: key, owner: j.Owner, dir: dir, start: start, job: j,
		cancel: cancel, pid: cmd.Process.Pid, stderr: stderr, created: now, done: make(chan struct{}),
		lastAccess: now, lastMedia: now, lastSeg: -1,
	}
	audio := -1
	if j.Audio != nil {
		audio = *j.Audio
	}
	log := s.log.With("kind", KindHLS, "session", sess.id, "start", fmtSeconds(start), "audio", audio, "video", j.Video)
	log.Info("job started")
	go func() {
		werr := cmd.Wait()
		<-s.jobs
		cancel()
		sess.mu.Lock()
		sess.exited = true
		closed := sess.closed
		if !closed {
			sess.exitErr = werr
			sess.refreshLocked()
		}
		ended := sess.ended
		sess.mu.Unlock()
		close(sess.done)
		switch {
		case closed:
			_ = os.RemoveAll(dir)
			log.Info("job ended", "reason", "closed", "seconds", time.Since(now).Round(time.Millisecond).Seconds())
		case werr != nil && !ended:
			s.failed.Add(1)
			log.Warn("job ended", "reason", "ffmpeg_error", "stderr", sanitize(stderr.b.String(), j))
		default:
			log.Info("job ended", "reason", "done", "seconds", time.Since(now).Round(time.Millisecond).Seconds())
		}
	}()
	return sess, nil
}

// closeHLS kills ffmpeg and deletes the session's files.
func (s *Server) closeHLS(sess *hlsSession, reason string) {
	s.hls.mu.Lock()
	if s.hls.byID[sess.id] == sess {
		delete(s.hls.byID, sess.id)
	}
	if s.hls.byKey[sess.key] == sess {
		delete(s.hls.byKey, sess.key)
	}
	s.hls.mu.Unlock()
	sess.mu.Lock()
	if sess.closed {
		sess.mu.Unlock()
		return
	}
	sess.closed = true
	exited := sess.exited
	sess.mu.Unlock()
	s.log.Info("hls session closed", "session", sess.id, "reason", reason)
	sess.cancel() // SIGKILL also ends a stopped process
	if exited {
		_ = os.RemoveAll(sess.dir)
	}
}

type readiness int

const (
	readyOK readiness = iota
	readyFailed
	readyGone
)

// waitReady waits for the first segments (or the end of a short stream).
func (s *Server) waitReady(ctx context.Context, sess *hlsSession) readiness {
	deadline := time.NewTimer(s.cfg.HLSStartWait)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		sess.mu.Lock()
		sess.refreshLocked()
		n, ended, exited, closed, exitErr := len(sess.segs), sess.ended, sess.exited, sess.closed, sess.exitErr
		sess.mu.Unlock()
		switch {
		case closed:
			return readyFailed
		case n >= hlsReadySegments || (ended && n > 0):
			return readyOK
		case exited:
			// Finished early: fine with any output, else it failed.
			if n > 0 && exitErr == nil {
				return readyOK
			}
			return readyFailed
		}
		select {
		case <-ctx.Done():
			return readyGone
		case <-deadline.C:
			return readyFailed
		case <-sess.done:
		case <-tick.C:
		}
	}
}

// hlsJanitor closes idle sessions and applies the throttle and retention.
func (s *Server) hlsJanitor() {
	tick := time.NewTicker(s.cfg.HLSTick)
	defer tick.Stop()
	for {
		select {
		case <-s.quit:
			return
		case <-tick.C:
		}
		for _, sess := range s.hls.list() {
			sess.mu.Lock()
			idle := time.Since(sess.lastAccess) > s.cfg.HLSIdle
			mediaIdle := time.Since(sess.lastMedia) > s.cfg.HLSMediaIdle
			sess.mu.Unlock()
			switch {
			case idle:
				s.closeHLS(sess, "idle")
			case mediaIdle:
				s.closeHLS(sess, "media_idle")
			default:
				sess.maintain(s.cfg)
			}
		}
	}
}

// ---------------------------------------------------------------- session state

func (h *hlsSession) touch(media bool) {
	h.mu.Lock()
	now := time.Now()
	h.lastAccess = now
	if media {
		h.lastMedia = now
	}
	h.mu.Unlock()
}

func (h *hlsSession) accessed() time.Time {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.lastAccess
}

func (h *hlsSession) requested(n int) {
	h.mu.Lock()
	h.lastSeg = n
	h.mu.Unlock()
}

func (h *hlsSession) running() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return !h.exited && !h.closed
}

func (h *hlsSession) reusable() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return !h.closed && !h.trimmed && (h.exitErr == nil || h.ended)
}

// failed: ffmpeg stopped with an error before the end of the file.
func (h *hlsSession) failed() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.refreshLocked()
	return h.exited && h.exitErr != nil && !h.ended
}

// mayAppear: segment n (-1 = init) isn't deleted and ffmpeg may still write it.
func (h *hlsSession) mayAppear(n int) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.exited {
		return false
	}
	return n < 0 || n >= len(h.segs) || !h.segs[n].gone
}

func (h *hlsSession) stderrString() string {
	h.stderr.mu.Lock()
	defer h.stderr.mu.Unlock()
	return h.stderr.b.String()
}

// bytes on disk (listed segments; the init segment is tiny).
func (h *hlsSession) diskBytes() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	var n int64
	for _, sg := range h.segs {
		if !sg.gone {
			n += sg.size
		}
	}
	return n
}

// refreshLocked re-reads the playlist when it changed (ffmpeg renames a new
// one into place after each segment).
func (h *hlsSession) refreshLocked() {
	if h.closed {
		return
	}
	path := filepath.Join(h.dir, hlsPlaylist)
	fi, err := os.Stat(path)
	if err != nil || (fi.ModTime().Equal(h.plMod) && fi.Size() == h.plSize) {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	h.plMod, h.plSize = fi.ModTime(), fi.Size()
	segs, ended := parsePlaylist(b)
	for i := range segs {
		if i < len(h.segs) {
			segs[i].size, segs[i].gone = h.segs[i].size, h.segs[i].gone
		}
		if segs[i].size == 0 && !segs[i].gone {
			if st, err := os.Stat(filepath.Join(h.dir, "seg"+strconv.Itoa(i)+".m4s")); err == nil {
				segs[i].size = st.Size()
			}
		}
	}
	if len(segs) >= len(h.segs) {
		h.segs = segs
	}
	h.ended = h.ended || ended
}

// parsePlaylist reads ffmpeg's media playlist: segment i is seg<i>.m4s.
func parsePlaylist(b []byte) ([]hlsSeg, bool) {
	var segs []hlsSeg
	var dur float64
	var t float64
	ended := false
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		switch {
		case strings.HasPrefix(line, "#EXTINF:"):
			v, _, _ := strings.Cut(strings.TrimPrefix(line, "#EXTINF:"), ",")
			dur, _ = strconv.ParseFloat(v, 64)
		case line == "#EXT-X-ENDLIST":
			ended = true
		case line != "" && !strings.HasPrefix(line, "#"):
			m := segName.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			if n, _ := strconv.Atoi(m[1]); n != len(segs) {
				continue
			}
			segs = append(segs, hlsSeg{start: t, dur: dur})
			t += dur
		}
	}
	return segs, ended
}

// maintain pauses / resumes ffmpeg around the player's position and deletes
// segments far behind it.
func (h *hlsSession) maintain(cfg Config) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.refreshLocked()
	n := len(h.segs)
	produced := 0.0
	if n > 0 {
		produced = h.segs[n-1].start + h.segs[n-1].dur
	}
	at := 0.0 // where the player is (start of the last requested segment)
	if h.lastSeg >= n {
		at = produced
	} else if h.lastSeg >= 0 {
		at = h.segs[h.lastSeg].start
	}
	var total, ahead int64
	for i, sg := range h.segs {
		if sg.gone {
			continue
		}
		total += sg.size
		if i >= h.lastSeg {
			ahead += sg.size
		}
	}
	// Retention: oldest first, only behind the last requested segment.
	keep := cfg.HLSKeepBehind.Seconds()
	for i := 0; i < h.lastSeg && i < n; i++ {
		sg := &h.segs[i]
		if sg.gone {
			continue
		}
		if sg.start+sg.dur >= at-keep && total <= cfg.HLSMaxBytes {
			break
		}
		if err := os.Remove(filepath.Join(h.dir, "seg"+strconv.Itoa(i)+".m4s")); err == nil || errors.Is(err, os.ErrNotExist) {
			sg.gone = true
			h.trimmed = true
			total -= sg.size
		}
	}
	if h.exited {
		return
	}
	// Throttle: ffmpeg stays at most HLSAhead (and half the byte budget)
	// ahead of the player.
	lead := produced - at
	far := lead > cfg.HLSAhead.Seconds() || ahead > cfg.HLSMaxBytes/2
	near := lead < 0.75*cfg.HLSAhead.Seconds() && ahead < cfg.HLSMaxBytes*3/8
	switch {
	case far && !h.stopped:
		if syscall.Kill(h.pid, syscall.SIGSTOP) == nil {
			h.stopped = true
		}
	case near && h.stopped:
		if syscall.Kill(h.pid, syscall.SIGCONT) == nil {
			h.stopped = false
		}
	}
}
