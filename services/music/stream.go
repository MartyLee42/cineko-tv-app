package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ---- YouTube resolve & play ----

// resolve returns the YouTube video for a catalog track (cached; concurrent
// calls for the same track share one search).
func (a *App) resolve(ctx context.Context, dzID int64) (string, error) {
	key := "dz:" + strconv.FormatInt(dzID, 10)
	if v, ok := a.st.Match(ctx, key); ok {
		return v, nil
	}
	a.resolveMu.Lock()
	if c, ok := a.resolving[key]; ok {
		a.resolveMu.Unlock()
		select {
		case <-c.done:
			return c.videoID, c.err
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	c := &resolveCall{done: make(chan struct{})}
	a.resolving[key] = c
	a.resolveMu.Unlock()

	// Detached from the request: a prefetch that the client abandons should
	// still fill the cache.
	rctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	c.videoID, c.err = a.resolveNow(rctx, key, dzID)
	cancel()
	close(c.done)
	a.resolveMu.Lock()
	delete(a.resolving, key)
	a.resolveMu.Unlock()
	return c.videoID, c.err
}

func (a *App) resolveNow(ctx context.Context, key string, dzID int64) (string, error) {
	t, err := a.dz.Track(ctx, dzID)
	if err != nil {
		return "", err
	}
	cands, err := a.yt.Candidates(ctx, t)
	if err != nil {
		return "", err
	}
	// Take the best-ranked candidate whose audio actually streams: some
	// uploads (often label ones) come back empty from the server's VPN exit.
	// The top few are probed in parallel; ranks are honoured.
	if len(cands) == 0 {
		return "", errYTNoMatch
	}
	n := min(len(cands), 4)
	floor := cands[0].Score - 45 // never fall back to a clearly different recording
	results := make([]chan bool, n)
	for i := 0; i < n; i++ {
		results[i] = make(chan bool, 1)
		if cands[i].Score < floor {
			results[i] <- false
			continue
		}
		go func(i int) { results[i] <- a.probeVideo(ctx, cands[i].VideoID) }(i)
	}
	for i := 0; i < n; i++ {
		if <-results[i] {
			c := cands[i]
			_ = a.st.SetMatch(ctx, key, c.VideoID, false)
			a.log.Debug("matched", "track", key, "video", c.VideoID, "rank", i, "score", c.Score, "title", c.Title)
			return c.VideoID, nil
		}
	}
	return "", errYTNoMatch
}

// probeVideo checks that a video's audio really delivers bytes.
func (a *App) probeVideo(ctx context.Context, videoID string) bool {
	if _, _, ok := a.cacheLookup(videoID); ok {
		return true
	}
	ctx, cancel := context.WithTimeout(ctx, 14*time.Second)
	defer cancel()
	au, err := a.yt.audio(ctx, videoID, false)
	if err != nil {
		return false
	}
	resp, err := a.yt.fetchRange(ctx, au.URL, 0, 16383)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusOK {
		return false
	}
	buf := make([]byte, 1024)
	n, _ := io.ReadAtLeast(resp.Body, buf, 1)
	return n > 0
}

func (a *App) cacheLookup(videoID string) (string, string, bool) {
	if a.cache == nil {
		return "", "", false
	}
	return a.cache.Lookup(videoID)
}

func (a *App) hResolve(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	v, err := a.resolve(r.Context(), id)
	if err != nil {
		return err
	}
	a.cacheAudio(v) // prefetch: the next track then plays from disk
	_, _, cached := a.cacheLookup(v)
	writeJSON(w, 200, map[string]any{"videoId": v, "cached": cached})
	return nil
}

func (a *App) hPlay(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	if a.serveManual(w, r, "dz:"+strconv.FormatInt(id, 10)) {
		return nil
	}
	fallback := func(ytErr error) error {
		t, terr := a.dz.Track(r.Context(), id)
		if terr != nil {
			return ytErr
		}
		return a.playFallback(w, r, t, ytErr)
	}
	v, err := a.resolve(r.Context(), id)
	if err != nil {
		// No YouTube upload (or YouTube unreachable): try the trackers.
		return fallback(err)
	}
	if a.serveCached(w, r, v) {
		return nil
	}
	a.cacheAudio(v)
	err = a.streamYT(w, r, v)
	if errors.Is(err, errYTNoAudio) {
		// The upload vanished since it was matched: match again once.
		key := "dz:" + strconv.FormatInt(id, 10)
		_ = a.st.ForgetMatch(r.Context(), key)
		if v2, err2 := a.resolve(r.Context(), id); err2 == nil && v2 != v {
			err = a.streamYT(w, r, v2)
		}
		if errors.Is(err, errYTNoAudio) {
			return fallback(err)
		}
	}
	return err
}

func (a *App) hYT(w http.ResponseWriter, r *http.Request, u *User) error {
	v := r.PathValue("vid")
	if !validVideoID(v) {
		return errStatus(400, "bad_request", "Некорректный id")
	}
	if r.URL.Query().Get("preview") == "" && a.serveManual(w, r, "yt:"+v) {
		return nil
	}
	if a.serveCached(w, r, v) {
		return nil
	}
	if r.URL.Query().Get("preview") == "" {
		a.cacheAudio(v)
	}
	return a.streamYT(w, r, v)
}

// hYTFind finds the YouTube upload for a track that is not in the catalog
// (imports from other services): ?artist=&title=&duration=. The best
// candidate that actually streams wins.
func (a *App) hYTFind(w http.ResponseWriter, r *http.Request, u *User) error {
	q := r.URL.Query()
	t := &Track{Artist: strings.TrimSpace(q.Get("artist")), Title: strings.TrimSpace(q.Get("title"))}
	t.Duration, _ = strconv.Atoi(q.Get("duration"))
	if t.Title == "" {
		return errStatus(400, "bad_request", "Нет названия")
	}
	cands, err := a.yt.Candidates(r.Context(), t)
	if err != nil {
		return err
	}
	for i, c := range cands {
		if i >= 4 || c.Score < cands[0].Score-45 {
			break
		}
		if a.probeVideo(r.Context(), c.VideoID) {
			writeJSON(w, 200, c)
			return nil
		}
	}
	return errYTNoMatch
}

func (a *App) hCandidates(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	t, err := a.dz.Track(r.Context(), id)
	if err != nil {
		return err
	}
	cands, err := a.yt.Candidates(r.Context(), t)
	if err != nil {
		return err
	}
	current, _ := a.st.Match(r.Context(), t.ID)
	writeJSON(w, 200, map[string]any{"current": current, "candidates": cands})
	return nil
}

func (a *App) hSetMatch(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	var b struct {
		VideoID string `json:"videoId"`
	}
	if err := readJSON(r, &b); err != nil {
		return err
	}
	if !validVideoID(b.VideoID) {
		return errStatus(400, "bad_request", "Некорректный id видео")
	}
	if err := a.st.SetMatch(r.Context(), "dz:"+strconv.FormatInt(id, 10), b.VideoID, true); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func (a *App) hForgetMatch(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	if err := a.st.ForgetMatch(r.Context(), "dz:"+strconv.FormatInt(id, 10)); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

var rangeRe = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

// parseRange handles a single "bytes=a-b" range against size.
func parseRange(h string, size int64) (from, to int64, partial bool, ok bool) {
	if h == "" {
		return 0, size - 1, false, true
	}
	m := rangeRe.FindStringSubmatch(strings.TrimSpace(h))
	if m == nil {
		return 0, size - 1, false, true // unsupported (multi-range): send everything
	}
	switch {
	case m[1] == "" && m[2] != "": // suffix: last N bytes
		n, _ := strconv.ParseInt(m[2], 10, 64)
		if n <= 0 {
			return 0, 0, true, false
		}
		if n > size {
			n = size
		}
		return size - n, size - 1, true, true
	case m[1] != "":
		from, _ = strconv.ParseInt(m[1], 10, 64)
		to = size - 1
		if m[2] != "" {
			to, _ = strconv.ParseInt(m[2], 10, 64)
			if to > size-1 {
				to = size - 1
			}
		}
		if from > to || from >= size {
			return 0, 0, true, false
		}
		return from, to, true, true
	}
	return 0, size - 1, false, true
}

// ytChunk: googlevideo refuses or throttles very large ranges, so the
// response is assembled from upstream chunks of this size.
const ytChunk = 4 << 20

// streamYT proxies a video's audio with HTTP Range support.
func (a *App) streamYT(w http.ResponseWriter, r *http.Request, videoID string) error {
	ctx := r.Context()
	au, err := a.yt.audio(ctx, videoID, false)
	if err != nil {
		if errors.Is(err, errYTNoAudio) {
			return err
		}
		return errYTNoAudio
	}
	if au.Size <= 0 {
		// Unknown size: probe it with a 1-byte range.
		if resp, err := a.yt.fetchRange(ctx, au.URL, 0, 0); err == nil {
			if cr := resp.Header.Get("Content-Range"); cr != "" {
				if i := strings.LastIndex(cr, "/"); i >= 0 {
					au.Size, _ = strconv.ParseInt(cr[i+1:], 10, 64)
				}
			}
			resp.Body.Close()
		}
		if au.Size <= 0 {
			return errYTNoAudio
		}
	}
	from, to, partial, ok := parseRange(r.Header.Get("Range"), au.Size)
	h := w.Header()
	h.Set("Accept-Ranges", "bytes")
	h.Set("Content-Type", au.Mime)
	h.Set("Cache-Control", "private, max-age=3600")
	if !ok {
		h.Set("Content-Range", fmt.Sprintf("bytes */%d", au.Size))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return nil
	}
	// Open the first chunk before answering, so failures become errors.
	first, err := a.ytChunk(ctx, videoID, &au, from, min(to, from+ytChunk-1))
	if err != nil {
		return err
	}
	h.Set("Content-Length", strconv.FormatInt(to-from+1, 10))
	if partial {
		h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, to, au.Size))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}
	if r.Method == http.MethodHead {
		first.Close()
		return nil
	}
	fl, _ := w.(http.Flusher)
	pos := from
	body := first
	for {
		n, err := io.Copy(w, body)
		body.Close()
		pos += n
		if err != nil || pos > to {
			return nil
		}
		if fl != nil {
			fl.Flush()
		}
		body, err = a.ytChunk(ctx, videoID, &au, pos, min(to, pos+ytChunk-1))
		if err != nil {
			return nil // headers are sent; the client sees a short body and retries
		}
	}
}

// ytChunk opens bytes [from,to] of the audio, refreshing expired URLs once.
func (a *App) ytChunk(ctx context.Context, videoID string, au *ytAudio, from, to int64) (io.ReadCloser, error) {
	for attempt := 0; attempt < 2; attempt++ {
		resp, err := a.yt.fetchRange(ctx, au.URL, from, to)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, fmt.Errorf("youtube audio: %w", err)
		}
		stale := resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusGone ||
			(resp.StatusCode == http.StatusOK && resp.ContentLength == 0)
		if stale && attempt == 0 {
			resp.Body.Close()
			fresh, err := a.yt.audio(ctx, videoID, true)
			if err != nil {
				return nil, errYTNoAudio
			}
			*au = fresh
			continue
		}
		if resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			if resp.StatusCode == http.StatusNotFound || stale {
				return nil, errYTNoAudio
			}
			return nil, fmt.Errorf("youtube audio: HTTP %d", resp.StatusCode)
		}
		return resp.Body, nil
	}
	return nil, errYTNoAudio
}

// ---- torrents ----

func (a *App) hTorrentSearch(w http.ResponseWriter, r *http.Request, u *User) error {
	q := r.URL.Query()
	artist, album, text := strings.TrimSpace(q.Get("artist")), strings.TrimSpace(q.Get("album")), strings.TrimSpace(q.Get("q"))
	var queries []string
	switch {
	case text != "":
		queries = []string{text}
	case artist != "" && album != "":
		queries = []string{artist + " " + album, artist + " дискография"}
	case artist != "":
		queries = []string{artist, artist + " дискография"}
	default:
		return errStatus(400, "bad_request", "Пустой запрос")
	}
	rs, err := a.tor.Search(r.Context(), queries, artist, album)
	if err != nil {
		return err
	}
	writeJSON(w, 200, rs)
	return nil
}

func (a *App) hTorrentOpen(w http.ResponseWriter, r *http.Request, u *User) error {
	if !a.tor.SearchConfigured() {
		return errTorrNotConfigured
	}
	var b struct {
		ID string `json:"id"`
	}
	if err := readJSON(r, &b); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	hash, err := a.tor.Open(ctx, a.st, b.ID)
	if err != nil {
		return err
	}
	a.log.Info("torrent opened", "user", u.Username, "hash", hash)
	writeJSON(w, 200, map[string]string{"hash": hash})
	return nil
}

func (a *App) hTorrentInfo(w http.ResponseWriter, r *http.Request, u *User) error {
	if !a.tor.Configured() {
		return errTorrNotConfigured
	}
	hash := strings.ToLower(r.PathValue("hash"))
	ctx, cancel := context.WithTimeout(r.Context(), 50*time.Second)
	defer cancel()
	info, err := a.tor.Info(ctx, a.st, hash, 12*time.Second)
	if err != nil {
		return err
	}
	if s := r.URL.Query().Get("album"); s != "" && info.Ready {
		if id, err := strconv.ParseInt(s, 10, 64); err == nil {
			if al, err := a.dz.Album(ctx, id); err == nil {
				info.Matched = MatchAlbum(al, info.Tracks)
			}
		}
	}
	writeJSON(w, 200, info)
	return nil
}

func (a *App) hTorrentStream(w http.ResponseWriter, r *http.Request, u *User) error {
	hash := strings.ToLower(r.PathValue("hash"))
	file, err := strconv.Atoi(r.PathValue("file"))
	if err != nil || file < 0 || !validHash(hash) {
		return errStatus(400, "bad_request", "Некорректный файл")
	}
	row, err := a.st.Torrent(r.Context(), hash)
	if err != nil {
		return errTorrNotFound // only torrents opened through this service
	}
	if _, err := a.tor.ensure(r.Context(), row); err != nil {
		return err
	}
	q := r.URL.Query()
	startMs, _ := strconv.ParseInt(q.Get("start"), 10, 64)
	endMs, _ := strconv.ParseInt(q.Get("end"), 10, 64)
	offset, _ := strconv.ParseFloat(q.Get("t"), 64)
	if q.Get("tc") == "1" || startMs > 0 || endMs > 0 || offset > 0 {
		return a.transcode(w, r, hash, file, startMs, endMs, offset)
	}
	resp, err := a.tor.openStream(r.Context(), hash, file, r.Header.Get("Range"))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	h := w.Header()
	for _, k := range []string{"Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if v := resp.Header.Get(k); v != "" {
			h.Set(k, v)
		}
	}
	ext := strings.ToLower(q.Get("ext"))
	ct := mimeByExt[ext]
	if ct == "" {
		ct = resp.Header.Get("Content-Type")
	}
	if ct == "" || strings.HasPrefix(ct, "application/octet-stream") || strings.HasPrefix(ct, "video/") {
		ct = "audio/mpeg"
		if m, ok := mimeByExt[ext]; ok {
			ct = m
		}
	}
	h.Set("Content-Type", ct)
	h.Set("Cache-Control", "private, max-age=3600")
	w.WriteHeader(resp.StatusCode)
	if r.Method == http.MethodHead {
		return nil
	}
	_, _ = io.Copy(flushWriter{w}, resp.Body)
	return nil
}

type flushWriter struct{ w http.ResponseWriter }

func (f flushWriter) Write(p []byte) (int, error) {
	n, err := f.w.Write(p)
	if fl, ok := f.w.(http.Flusher); ok {
		fl.Flush()
	}
	return n, err
}

// transcode streams a file (or a CUE segment of it) as MP3 320k from
// startMs+offset to endMs. No ranges: seeking re-requests with ?t=.
func (a *App) transcode(w http.ResponseWriter, r *http.Request, hash string, file int, startMs, endMs int64, offset float64) error {
	select {
	case a.tcSem <- struct{}{}:
		defer func() { <-a.tcSem }()
	default:
		return errStatus(503, "busy", "Сервер занят перекодированием, попробуйте позже")
	}
	in := a.tor.streamURL(hash, file)
	ss := float64(startMs)/1000 + offset
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin"}
	if a.tor.torrAuth != "" {
		args = append(args, "-headers", "Authorization: "+a.tor.torrAuth+"\r\n")
	}
	args = append(args, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5")
	if ss > 0 {
		args = append(args, "-ss", strconv.FormatFloat(ss, 'f', 3, 64))
	}
	args = append(args, "-i", in)
	if endMs > 0 {
		dur := float64(endMs)/1000 - ss
		if dur <= 0 {
			return errStatus(416, "bad_range", "За пределами трека")
		}
		args = append(args, "-t", strconv.FormatFloat(dur, 'f', 3, 64))
	}
	args = append(args, "-map", "0:a:0", "-vn", "-sn", "-c:a", "libmp3lame", "-b:a", "320k", "-ar", "44100", "-f", "mp3", "pipe:1")
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "audio/mpeg")
		w.WriteHeader(200)
		return nil
	}
	cmd := exec.CommandContext(r.Context(), "ffmpeg", args...)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr strings.Builder
	cmd.Stderr = &limitedWriter{w: &stderr, n: 2000}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("ffmpeg: %w", err)
	}
	// Wait for the first bytes before committing to a 200.
	buf := make([]byte, 32<<10)
	n, rerr := io.ReadAtLeast(out, buf, 1)
	if n == 0 {
		_ = cmd.Wait()
		a.log.Warn("transcode produced nothing", "hash", hash, "file", file, "err", strings.TrimSpace(stderr.String()), "read", errString(rerr))
		return errStatus(502, "transcode_failed", "Не удалось воспроизвести файл")
	}
	h := w.Header()
	h.Set("Content-Type", "audio/mpeg")
	h.Set("Cache-Control", "no-store")
	h.Set("Accept-Ranges", "none")
	w.WriteHeader(200)
	fw := flushWriter{w}
	if _, err := fw.Write(buf[:n]); err == nil {
		_, _ = io.Copy(fw, out)
	}
	_ = cmd.Wait()
	return nil
}

type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n <= 0 {
		return len(p), nil
	}
	q := p
	if len(q) > l.n {
		q = q[:l.n]
	}
	l.n -= len(q)
	_, _ = l.w.Write(q)
	return len(p), nil
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// ---- lyrics (LRCLIB) ----

type Lyrics struct {
	Plain        string `json:"plain"`
	Synced       string `json:"synced"`
	Instrumental bool   `json:"instrumental"`
}

func (a *App) hLyrics(w http.ResponseWriter, r *http.Request, u *User) error {
	q := r.URL.Query()
	artist, title, album := q.Get("artist"), q.Get("title"), q.Get("album")
	dur, _ := strconv.Atoi(q.Get("duration"))
	if artist == "" || title == "" {
		return errStatus(400, "bad_request", "Нет названия")
	}
	key := fmt.Sprintf("%s|%s|%s|%d", artist, title, album, dur)
	if b, ok := a.lyrics.get(key); ok {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
		return nil
	}
	type lr struct {
		PlainLyrics  string  `json:"plainLyrics"`
		SyncedLyrics string  `json:"syncedLyrics"`
		Instrumental bool    `json:"instrumental"`
		Duration     float64 `json:"duration"`
	}
	get := func(path string, v url.Values, out any) (int, error) {
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, a.cfg.LyricsURL+path+"?"+v.Encode(), nil)
		if err != nil {
			return 0, err
		}
		req.Header.Set("User-Agent", "MartyMusic/1.0 (self-hosted household player)")
		resp, err := a.ext.Do(req)
		if err != nil {
			return 0, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return resp.StatusCode, nil
		}
		return 200, json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(out)
	}
	var found *lr
	v := url.Values{"artist_name": {artist}, "track_name": {title}}
	if album != "" {
		v.Set("album_name", album)
	}
	if dur > 0 {
		v.Set("duration", strconv.Itoa(dur))
	}
	var one lr
	status, err := get("/api/get", v, &one)
	if err != nil {
		return fmt.Errorf("lrclib: %w", shortErr(err))
	}
	if status == 200 {
		found = &one
	} else {
		var many []lr
		if st, err := get("/api/search", url.Values{"artist_name": {artist}, "track_name": {title}}, &many); err == nil && st == 200 {
			for i := range many {
				if dur == 0 || many[i].Duration == 0 || abs(int(many[i].Duration)-dur) <= 4 {
					if many[i].SyncedLyrics != "" || many[i].PlainLyrics != "" || many[i].Instrumental {
						found = &many[i]
						break
					}
				}
			}
		}
	}
	out := Lyrics{}
	if found != nil {
		out = Lyrics{Plain: found.PlainLyrics, Synced: found.SyncedLyrics, Instrumental: found.Instrumental}
	}
	b, _ := json.Marshal(out)
	a.lyrics.set(key, b, 24*time.Hour)
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(b)
	return nil
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// ---- images ----

// hImage proxies Deezer cover/artist images with a disk cache.
func (a *App) hImage(w http.ResponseWriter, r *http.Request, u *User) error {
	raw := r.URL.Query().Get("u")
	// "yt:<videoId>": a YouTube thumbnail, through Invidious.
	if vid, ok := strings.CutPrefix(raw, "yt:"); ok {
		if !validVideoID(vid) || a.yt.base == nil {
			return errStatus(400, "bad_image", "Недопустимый адрес")
		}
		raw = a.yt.base.String() + "/vi/" + vid + "/mqdefault.jpg"
	}
	pu, err := url.Parse(raw)
	ytThumb := a.yt.base != nil && pu != nil && strings.EqualFold(pu.Host, a.yt.base.Host) && strings.HasPrefix(pu.Path, "/vi/")
	if err != nil || !ytThumb && (pu.Scheme != "https" || !strings.HasSuffix(pu.Hostname(), ".dzcdn.net") && pu.Hostname() != "cdnimg.zaycev.net") {
		return errStatus(400, "bad_image", "Недопустимый адрес")
	}
	sum := sha1.Sum([]byte(pu.String()))
	name := hex.EncodeToString(sum[:])
	dir := filepath.Join(a.cfg.DataDir, "img", name[:2])
	file := filepath.Join(dir, name)
	w.Header().Set("Cache-Control", "public, max-age=2592000, immutable")
	if f, err := os.Open(file); err == nil {
		defer f.Close()
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = io.Copy(w, f)
		return nil
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, pu.String(), nil)
	if err != nil {
		return err
	}
	hc := a.ext
	if ytThumb {
		hc = a.yt.hc
	}
	resp, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("image: %w", shortErr(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return errStatus(404, "not_found", "Нет изображения")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err == nil {
		tmp := file + ".tmp"
		if os.WriteFile(tmp, body, 0o600) == nil {
			_ = os.Rename(tmp, file)
		}
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "image/") {
		ct = "image/jpeg"
	}
	w.Header().Set("Content-Type", ct)
	_, _ = w.Write(body)
	return nil
}
