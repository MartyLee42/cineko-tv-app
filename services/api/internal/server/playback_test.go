package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/playback"
	"martytv/api/internal/releases"
	"martytv/api/internal/testutil"
)

const (
	tsUser   = "ts-user"
	tsPass   = "ts-pass-SECRET"
	prowKey  = "PROWLARR-KEY-SECRET"
	hashMov  = "1111111111111111111111111111111111111111"
	hashSlow = "2222222222222222222222222222222222222222"
	hashDead = "3333333333333333333333333333333333333333"
	hashRedi = "4444444444444444444444444444444444444444"
	hashUpl  = "5555555555555555555555555555555555555555"
	hashShow = "6666666666666666666666666666666666666666"
)

type tsFile struct {
	ID     int    `json:"id"`
	Path   string `json:"path"`
	Length int64  `json:"length"`
}

type tsTorrent struct {
	hash  string
	files []tsFile
	gets  int
}

// mockTorrServer implements the MatriX.141 routes playback uses.
type mockTorrServer struct {
	t       *testing.T
	srv     *httptest.Server
	payload []byte

	mu        sync.Mutex
	torrents  map[string]*tsTorrent
	metaAfter map[string]int // hash → gets before metadata appears (-1 never)
	files     map[string][]tsFile
	log       []string // "METHOD path?query"
	streams   []string // raw /stream queries
	uploads   int
	ranges    []string
	// endless makes /stream write forever; aborted is closed when the
	// proxy cancels that upstream request.
	endless bool
	aborted chan struct{}
	// listTorrents makes "list" return the added torrents (default: []).
	listTorrents bool
}

func newMockTorrServer(t *testing.T) *mockTorrServer {
	m := &mockTorrServer{t: t, torrents: map[string]*tsTorrent{}, metaAfter: map[string]int{}, files: map[string][]tsFile{}}
	m.payload = make([]byte, 256<<10)
	for i := range m.payload {
		m.payload[i] = byte(i * 7)
	}
	m.srv = httptest.NewServer(http.HandlerFunc(m.serve))
	t.Cleanup(m.srv.Close)
	return m
}

var btih = regexp.MustCompile(`btih:([0-9a-fA-F]{40})`)

func (m *mockTorrServer) filesFor(hash string) []tsFile {
	if f, ok := m.files[hash]; ok {
		return f
	}
	return []tsFile{
		{1, "Movie.2010.1080p/Movie.2010.1080p.mkv", int64(len(m.payload))},
		{2, "Movie.2010.1080p/Sample/sample.mkv", 1000},
		{3, "Movie.2010.1080p/Movie.nfo", 10},
	}
}

func (m *mockTorrServer) status(t *tsTorrent) map[string]any {
	out := map[string]any{"hash": t.hash, "title": "x", "stat": 1, "stat_string": "Torrent getting info"}
	after, ok := m.metaAfter[t.hash]
	if !ok || (after >= 0 && t.gets > after) {
		out["stat"], out["stat_string"] = 3, "Torrent working"
		out["file_stats"] = m.filesFor(t.hash)
		out["active_peers"], out["connected_seeders"], out["download_speed"], out["preloaded_bytes"] = 7, 3, 1234.5, 4096
		out["total_peers"], out["preload_size"] = 42, 33554432
	}
	return out
}

func (m *mockTorrServer) serve(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	m.log = append(m.log, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery)
	m.mu.Unlock()
	if r.URL.Path == "/echo" {
		_, _ = io.WriteString(w, "MatriX.141")
		return
	}
	if u, p, ok := r.BasicAuth(); !ok || u != tsUser || p != tsPass {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case r.URL.Path == "/torrents" && r.Method == http.MethodPost:
		var req struct{ Action, Link, Hash string }
		_ = json.NewDecoder(r.Body).Decode(&req)
		switch req.Action {
		case "add":
			mm := btih.FindStringSubmatch(req.Link)
			if mm == nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			h := strings.ToLower(mm[1])
			if m.torrents[h] == nil {
				m.torrents[h] = &tsTorrent{hash: h}
			}
			writeJSON(w, m.status(m.torrents[h]))
		case "get":
			t := m.torrents[req.Hash]
			if t == nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			t.gets++
			writeJSON(w, m.status(t))
		case "rem":
			delete(m.torrents, req.Hash)
		case "list":
			out := []any{}
			if m.listTorrents { // downloads_test.go: admin TorrServer list
				for _, t := range m.torrents {
					st := m.status(t)
					st["timestamp"], st["torrent_size"] = 1761700000, 123456
					out = append(out, st)
				}
			}
			writeJSON(w, out)
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	case r.URL.Path == "/torrent/upload" && r.Method == http.MethodPost:
		f, _, err := r.FormFile("file")
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		b, _ := io.ReadAll(f)
		if !bytes.HasPrefix(b, []byte("d")) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		m.uploads++
		m.torrents[hashUpl] = &tsTorrent{hash: hashUpl}
		writeJSON(w, m.status(m.torrents[hashUpl]))
	case r.URL.Path == "/stream" && r.Method == http.MethodGet:
		if m.endless {
			m.mu.Unlock()
			w.Header().Set("Content-Type", "video/x-matroska")
			w.WriteHeader(http.StatusOK)
			chunk := make([]byte, 32<<10)
			for {
				if _, err := w.Write(chunk); err != nil {
					break
				}
				w.(http.Flusher).Flush()
				select {
				case <-r.Context().Done():
				case <-time.After(5 * time.Millisecond):
					continue
				}
				break
			}
			close(m.aborted)
			m.mu.Lock()
			return
		}
		m.streams = append(m.streams, r.URL.RawQuery)
		m.ranges = append(m.ranges, r.Header.Get("Range"))
		q := r.URL.Query()
		t := m.torrents[q.Get("link")]
		if t == nil || !q.Has("play") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		for _, f := range m.filesFor(t.hash) {
			if fmt.Sprint(f.ID) == q.Get("index") {
				n := min(int(f.Length), len(m.payload))
				// TorrServer-like generic type; the proxy must fix it up.
				w.Header().Set("Content-Type", "application/octet-stream")
				http.ServeContent(w, r, "", time.Unix(1700000000, 0), bytes.NewReader(m.payload[:n]))
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
	case strings.HasPrefix(r.URL.Path, "/ffp/"):
		writeJSON(w, map[string]any{
			"streams": []any{
				map[string]any{"index": 0, "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "profile": "High 10", "pix_fmt": "yuv420p10le", "level": 41, "field_order": "progressive", "disposition": map[string]int{"default": 1}},
				map[string]any{"index": 1, "codec_type": "audio", "codec_name": "aac", "channels": 2, "tags": map[string]string{"language": "rus", "title": "Дубляж"}, "disposition": map[string]int{"default": 1}},
				map[string]any{"index": 2, "codec_type": "audio", "codec_name": "ac3", "channels": 6, "tags": map[string]string{"language": "eng"}},
				map[string]any{"index": 3, "codec_type": "subtitle", "codec_name": "subrip", "tags": map[string]string{"language": "rus"}},
			},
			"format": map[string]any{"format_name": "matroska,webm", "duration": "5400.5"},
		})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (m *mockTorrServer) setMetaAfter(hash string, n int) {
	m.mu.Lock()
	m.metaAfter[hash] = n
	m.mu.Unlock()
}

func (m *mockTorrServer) setFiles(hash string, f []tsFile) {
	m.mu.Lock()
	m.files[hash] = f
	m.mu.Unlock()
}

func (m *mockTorrServer) lastStream() (string, string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.streams) == 0 {
		return "", ""
	}
	return m.streams[len(m.streams)-1], m.ranges[len(m.ranges)-1]
}

func (m *mockTorrServer) requests() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.log...)
}

// fakeResolver stands in for the releases package.
type fakeResolver struct{ m map[string]*releases.Resolved }

func (f *fakeResolver) Resolve(_ context.Context, mediaID, releaseID string) (*releases.Resolved, error) {
	r, ok := f.m[releaseID]
	if !ok || r.MediaID != mediaID {
		return nil, releases.ErrReleaseNotFound
	}
	cp := *r
	return &cp, nil
}

func rel(id, title string, hash *string) releases.Release {
	return releases.Release{ID: id, Title: title, Indexer: "test", InfoHash: hash, AudioCodecs: []string{}, Languages: []string{},
		Seasons: []int{}, Episodes: []int{}, Reasons: []string{}, Warnings: []string{}}
}

func magnet(h string) string {
	return "magnet:?xt=urn:btih:" + strings.ToUpper(h) + "&dn=x&tr=udp%3A%2F%2Ftracker.example%3A80"
}

type playbackEnv struct {
	*testutil.Env
	ts       *mockTorrServer
	resolver *fakeResolver
	movieID  string
	showID   string
	episodes map[int]string // episode number (season 1) → id
}

func newPlaybackEnv(t *testing.T, opts ...testutil.Options) *playbackEnv {
	ts := newMockTorrServer(t)
	prowlarr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("apikey") != prowKey {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/v1/indexer/1/download":
			w.Header().Set("Content-Type", "application/x-bittorrent")
			_, _ = io.WriteString(w, "d8:announce3:udp4:infod4:name1:aee")
		case "/api/v1/indexer/2/download":
			http.Redirect(w, r, magnet(hashRedi), http.StatusMovedPermanently)
		}
	}))
	t.Cleanup(prowlarr.Close)

	env := testutil.New(t, func(c *config.Config) {
		c.TorrServer = config.TorrServerConfig{URL: ts.srv.URL, Username: tsUser, Password: tsPass}
		c.Prowlarr = config.ProwlarrConfig{URL: prowlarr.URL, APIKey: prowKey}
		for _, o := range opts {
			o(c)
		}
	})
	tm := playback.DefaultTimings()
	tm.InlineWait, tm.MetadataTimeout, tm.PollInterval, tm.StatsTimeout = 1500*time.Millisecond, 1200*time.Millisecond, 20*time.Millisecond, time.Second
	env.Server.Playback.SetTimings(tm)
	t.Cleanup(env.Server.Playback.Wait)

	pe := &playbackEnv{Env: env, ts: ts, episodes: map[int]string{}}
	ctx := context.Background()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(env.Pool.QueryRow(ctx, `INSERT INTO media (kind, tmdb_id) VALUES ('movie', 100) RETURNING id`).Scan(&pe.movieID))
	must(env.Pool.QueryRow(ctx, `INSERT INTO media (kind, tmdb_id) VALUES ('series', 200) RETURNING id`).Scan(&pe.showID))
	var seasonID string
	must(env.Pool.QueryRow(ctx, `INSERT INTO seasons (media_id, season_number) VALUES ($1, 1) RETURNING id`, pe.showID).Scan(&seasonID))
	for e := 1; e <= 4; e++ {
		var id string
		must(env.Pool.QueryRow(ctx, `INSERT INTO episodes (media_id, season_id, season_number, episode_number)
			VALUES ($1, $2, 1, $3) RETURNING id`, pe.showID, seasonID, e).Scan(&id))
		pe.episodes[e] = id
	}

	h := func(s string) *string { return &s }
	showRel := rel("show-pack", "Show.S01.1080p", h(hashShow))
	showRel.Seasons = []int{1}
	pe.resolver = &fakeResolver{m: map[string]*releases.Resolved{
		"mov":    {MediaID: pe.movieID, Release: rel("mov", "Movie.2010.1080p", h(hashMov)), MagnetURI: magnet(hashMov)},
		"slow":   {MediaID: pe.movieID, Release: rel("slow", "Slow", nil), MagnetURI: magnet(hashSlow)},
		"dead":   {MediaID: pe.movieID, Release: rel("dead", "Dead", nil), MagnetURI: magnet(hashDead)},
		"upload": {MediaID: pe.movieID, Release: rel("upload", "Upload", nil), DownloadURL: prowlarr.URL + "/api/v1/indexer/1/download?apikey=" + prowKey + "&link=abc"},
		"redir":  {MediaID: pe.movieID, Release: rel("redir", "Redirected", nil), DownloadURL: prowlarr.URL + "/api/v1/indexer/2/download?apikey=" + prowKey},
		"ssrf":   {MediaID: pe.movieID, Release: rel("ssrf", "Evil", nil), DownloadURL: ts.srv.URL + "/settings"},
		"show":   {MediaID: pe.showID, Release: showRel, MagnetURI: magnet(hashShow)},
	}}
	env.Server.Playback.SetResolver(pe.resolver)

	ts.setMetaAfter(hashSlow, 25)
	ts.setMetaAfter(hashDead, -1)
	var showFiles []tsFile
	for e := 1; e <= 3; e++ {
		showFiles = append(showFiles, tsFile{e, fmt.Sprintf("Show.S01.1080p/Show.S01E%02d.1080p.mkv", e), int64(len(ts.payload))})
	}
	showFiles = append(showFiles, tsFile{4, "Show.S01.1080p/Show.S01.Extras.mkv", 99999999})
	ts.setFiles(hashShow, showFiles)
	return pe
}

// assertClean fails if a response leaks TorrServer/Prowlarr details.
func (pe *playbackEnv) assertClean(body []byte) {
	pe.T.Helper()
	for _, s := range []string{tsPass, tsUser, prowKey, pe.ts.srv.URL, strings.TrimPrefix(pe.ts.srv.URL, "http://"), "magnet:", "btih"} {
		if bytes.Contains(body, []byte(s)) {
			pe.T.Fatalf("response leaks %q: %s", s, body)
		}
	}
}

func (pe *playbackEnv) waitStatus(c *testutil.Client, id, want string) map[string]any {
	pe.T.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		res := c.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200)
		pe.assertClean(res.Body)
		got := res.JSON()
		if got["status"] == want {
			return got
		}
		if time.Now().After(deadline) {
			pe.T.Fatalf("source %s: status %v, want %s", id, got["status"], want)
		}
		time.Sleep(30 * time.Millisecond)
	}
}

func TestPlaybackMovieLifecycleAndStream(t *testing.T) {
	pe := newPlaybackEnv(t)
	alice, _ := pe.NewUserClient("alice", "user")

	// Unknown release / validation.
	if code := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "nope"}).Expect(404).ErrorCode(); code != "release_not_found" {
		t.Fatal(code)
	}
	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": "x", "release_id": "mov"}).Expect(422)
	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov", "episode_id": pe.episodes[1]}).Expect(422)

	// Metadata arrives quickly → ready inline.
	res := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov"}).Expect(201)
	pe.assertClean(res.Body)
	src := res.JSON()
	if src["status"] != "ready" || src["error"] != nil {
		t.Fatalf("not ready: %s", res.Body)
	}
	id := src["id"].(string)
	file := src["file"].(map[string]any)
	if file["index"].(float64) != 1 || file["path"] != "Movie.2010.1080p/Movie.2010.1080p.mkv" || src["mime_type"] != "video/x-matroska" {
		t.Fatalf("file: %s", res.Body)
	}
	streamURL, _ := src["stream_url"].(string)
	if !strings.HasPrefix(streamURL, "/api/v1/stream/") || src["stream_expires_at"] == nil {
		t.Fatalf("stream url: %s", res.Body)
	}
	if src["release"].(map[string]any)["id"] != "mov" {
		t.Fatal("release missing")
	}

	// Reuse.
	again := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov"}).Expect(201).JSON()
	if again["id"] != id {
		t.Fatalf("not reused: %v vs %v", again["id"], id)
	}

	// GET: live stats, then ffprobe media info (background).
	got := alice.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200).JSON()
	tor, _ := got["torrent"].(map[string]any)
	if tor == nil || tor["peers"].(float64) != 7 || tor["seeders"].(float64) != 3 || tor["download_speed_bps"].(float64) != 1234.5 || tor["preloaded_bytes"].(float64) != 4096 ||
		tor["total_peers"].(float64) != 42 || tor["preload_size"].(float64) != 33554432 || tor["stage"] != "working" {
		t.Fatalf("torrent stats: %v", got["torrent"])
	}
	var mi map[string]any
	for i := 0; i < 100 && mi == nil; i++ {
		time.Sleep(20 * time.Millisecond)
		mi, _ = alice.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200).JSON()["media_info"].(map[string]any)
	}
	if mi == nil || mi["video_codec"] != "h264" || mi["height"].(float64) != 1080 || mi["duration_seconds"].(float64) != 5400.5 ||
		len(mi["audio"].([]any)) != 2 || len(mi["subtitles"].([]any)) != 1 {
		t.Fatalf("media info: %v", mi)
	}
	a0 := mi["audio"].([]any)[0].(map[string]any)
	if a0["language"] != "rus" || a0["title"] != "Дубляж" || a0["channels"].(float64) != 2 || a0["default"] != true {
		t.Fatalf("audio: %v", a0)
	}
	if mi["video_profile"] != "High 10" || mi["pix_fmt"] != "yuv420p10le" || mi["bit_depth"].(float64) != 10 ||
		mi["video_level"].(float64) != 41 || mi["interlaced"] != false || mi["probe_version"].(float64) != 3 {
		t.Fatalf("video details: %v", mi)
	}

	// A row probed before the video details existed is re-probed lazily
	// (MediaInfoRetry apart; 0 here so it happens right away).
	if _, err := pe.Pool.Exec(context.Background(), `UPDATE playback_sources SET media_info = '{"container":"matroska,webm","video_codec":"h264","width":1920,"height":1080,"duration_seconds":5400.5,"audio":[],"subtitles":[]}' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	tm := playback.DefaultTimings()
	tm.InlineWait, tm.MetadataTimeout, tm.PollInterval, tm.StatsTimeout = 1500*time.Millisecond, 1200*time.Millisecond, 20*time.Millisecond, time.Second
	tm.MediaInfoRetry = 0
	pe.Server.Playback.SetTimings(tm)
	mi = nil
	for i := 0; i < 100 && (mi == nil || mi["bit_depth"] == nil); i++ {
		time.Sleep(20 * time.Millisecond)
		mi, _ = alice.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200).JSON()["media_info"].(map[string]any)
	}
	if mi["bit_depth"] == nil || mi["bit_depth"].(float64) != 10 || len(mi["audio"].([]any)) != 2 {
		t.Fatalf("re-probed media info: %v", mi)
	}

	// Before ffprobe knows the length, the release carries a bitrate
	// estimate from the TMDB runtime (the slow-torrent hint needs it).
	ctx := context.Background()
	if _, err := pe.Pool.Exec(ctx, `UPDATE playback_sources SET media_info = NULL, release = release - 'est_bitrate_bps' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := pe.Pool.Exec(ctx, `UPDATE media SET runtime = 90 WHERE id = $1`, pe.movieID); err != nil {
		t.Fatal(err)
	}
	est := alice.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200).JSON()
	fsize := est["file"].(map[string]any)["size_bytes"].(float64)
	if got, _ := est["release"].(map[string]any)["est_bitrate_bps"].(float64); fsize <= 0 || got != math.Round(fsize*8/5400) {
		t.Fatalf("est bitrate %v for size %v", est["release"].(map[string]any)["est_bitrate_bps"], fsize)
	}

	// Files.
	items := alice.Do("GET", "/api/v1/playback/sources/"+id+"/files", nil).Expect(200).Items()
	if len(items) != 3 || items[0]["is_video"] != true || items[2]["is_video"] != false {
		t.Fatalf("files: %v", items)
	}

	// PATCH validation and switching.
	alice.Do("PATCH", "/api/v1/playback/sources/"+id, map[string]any{"file_index": 3}).Expect(422)
	alice.Do("PATCH", "/api/v1/playback/sources/"+id, map[string]any{"file_index": 99}).Expect(422)
	alice.Do("PATCH", "/api/v1/playback/sources/"+id, map[string]any{"file_index": -1}).Expect(422)
	alice.Do("PATCH", "/api/v1/playback/sources/"+id, map[string]any{}).Expect(422)
	p := alice.Do("PATCH", "/api/v1/playback/sources/"+id, map[string]any{"file_index": 2}).Expect(200).JSON()
	if p["file"].(map[string]any)["path"] != "Movie.2010.1080p/Sample/sample.mkv" || p["media_info"] != nil {
		t.Fatalf("patched: %v", p)
	}
	p = alice.Do("PATCH", "/api/v1/playback/sources/"+id, map[string]any{"file_index": 1}).Expect(200).JSON()
	streamURL = p["stream_url"].(string)

	// Stream: no credentials needed, Range → 206 passthrough.
	anon := pe.Client()
	r := anon.Do("GET", streamURL, nil, "Range", "bytes=10-19")
	r.Expect(206)
	if !bytes.Equal(r.Body, pe.ts.payload[10:20]) {
		t.Fatalf("range body %v", r.Body)
	}
	size := len(pe.ts.payload)
	if r.Header.Get("Content-Range") != fmt.Sprintf("bytes 10-19/%d", size) || r.Header.Get("Content-Length") != "10" ||
		r.Header.Get("Content-Type") != "video/x-matroska" || r.Header.Get("Accept-Ranges") != "bytes" ||
		r.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("range headers %v", r.Header)
	}
	q, rng := pe.ts.lastStream()
	if q != "index=1&link="+hashMov+"&play=" || rng != "bytes=10-19" {
		t.Fatalf("upstream query %q range %q", q, rng)
	}
	pe.assertClean([]byte(fmt.Sprint(r.Header)))

	// Client-supplied query parameters never reach TorrServer.
	r = anon.Do("GET", streamURL+"?link=evil&index=3&url=http://169.254.169.254/", nil)
	r.Expect(200)
	if len(r.Body) != size || !bytes.Equal(r.Body, pe.ts.payload) {
		t.Fatalf("full body %d", len(r.Body))
	}
	if q, _ := pe.ts.lastStream(); q != "index=1&link="+hashMov+"&play=" {
		t.Fatalf("client influenced upstream: %q", q)
	}
	// Suffix range and unsatisfiable range.
	anon.Do("GET", streamURL, nil, "Range", "bytes=-5").Expect(206)
	anon.Do("GET", streamURL, nil, "Range", fmt.Sprintf("bytes=%d-", size+10)).Expect(416)

	// HEAD answers from the DB.
	streams := len(pe.ts.streams)
	h := anon.Do("HEAD", streamURL, nil)
	h.Expect(200)
	if h.Header.Get("Content-Length") != fmt.Sprint(size) || h.Header.Get("Accept-Ranges") != "bytes" || h.Header.Get("Content-Type") != "video/x-matroska" {
		t.Fatalf("head %v", h.Header)
	}
	h = anon.Do("HEAD", streamURL, nil, "Range", "bytes=0-99")
	h.Expect(206)
	if h.Header.Get("Content-Range") != fmt.Sprintf("bytes 0-99/%d", size) || h.Header.Get("Content-Length") != "100" {
		t.Fatalf("head range %v", h.Header)
	}
	if len(pe.ts.streams) != streams {
		t.Fatal("HEAD hit TorrServer")
	}

	// Named variant for external players: the file name is ignored.
	named := anon.Do("GET", streamURL+"/whatever..%2F..%2Fsettings.mp4", nil, "Range", "bytes=0-9")
	named.Expect(206)
	if !bytes.Equal(named.Body, pe.ts.payload[:10]) || named.Header.Get("Content-Type") != "video/x-matroska" {
		t.Fatalf("named stream %v", named.Header)
	}
	if q, _ := pe.ts.lastStream(); q != "index=1&link="+hashMov+"&play=" {
		t.Fatalf("filename influenced upstream: %q", q)
	}
	if cd := named.Header.Get("Content-Disposition"); cd != `inline; filename="Movie.2010.1080p.mkv"; filename*=UTF-8''Movie.2010.1080p.mkv` {
		t.Fatalf("content-disposition %q", cd)
	}
	hn := anon.Do("HEAD", streamURL+"/Movie.mkv", nil)
	hn.Expect(200)
	if hn.Header.Get("Content-Length") != fmt.Sprint(size) || hn.Header.Get("Content-Disposition") == "" {
		t.Fatalf("named head %v", hn.Header)
	}
	anon.Do("GET", "/api/v1/stream/bogus/Movie.mkv", nil).Expect(403)

	// Bad / tampered tokens.
	tok := strings.TrimPrefix(streamURL, "/api/v1/stream/")
	for _, bad := range []string{"x", tok[:len(tok)-1] + flip(tok[len(tok)-1:]), flip(tok[:1]) + tok[1:], "..%2F..%2Fsettings"} {
		if code := anon.Do("GET", "/api/v1/stream/"+bad, nil).Expect(403).ErrorCode(); code != "invalid_stream_token" {
			t.Fatalf("bad token %q: %s", bad, code)
		}
	}

	// Admin routes were never called.
	for _, req := range pe.ts.requests() {
		for _, bad := range []string{"/settings", "/shutdown", "/storage"} {
			if strings.Contains(req, bad) {
				t.Fatalf("called %s", req)
			}
		}
	}
}

func flip(s string) string {
	if s == "A" {
		return "B"
	}
	return "A"
}

func TestPlaybackPreparingTimeoutsAndDownloads(t *testing.T) {
	pe := newPlaybackEnv(t)
	alice, _ := pe.NewUserClient("alice", "user")
	tm := playback.DefaultTimings()
	tm.InlineWait, tm.MetadataTimeout, tm.PollInterval, tm.StatsTimeout = 50*time.Millisecond, 1200*time.Millisecond, 20*time.Millisecond, time.Second
	pe.Server.Playback.SetTimings(tm)

	// Slow metadata: 201 preparing, then ready.
	src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "slow"}).Expect(201).JSON()
	if src["status"] != "preparing" || src["stream_url"] != nil || src["file"] != nil {
		t.Fatalf("expected preparing: %v", src)
	}
	ready := pe.waitStatus(alice, src["id"].(string), "ready")
	if ready["stream_url"] == nil {
		t.Fatal("no stream url")
	}
	// PATCH on a preparing source is refused.
	dead := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "dead"}).Expect(201).JSON()
	alice.Do("PATCH", "/api/v1/playback/sources/"+dead["id"].(string), map[string]any{"file_index": 1}).Expect(409)
	// No peers: no_metadata.
	failed := pe.waitStatus(alice, dead["id"].(string), "error")
	if failed["error"] != "no_metadata" || failed["stream_url"] != nil {
		t.Fatalf("dead: %v", failed)
	}
	// The stream of a failed source is not served even with a valid-looking flow.
	// (No token is issued for it.)

	// .torrent download through Prowlarr → upload to TorrServer.
	up := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "upload"})
	pe.assertClean(up.Expect(201).Body)
	pe.waitStatus(alice, up.JSON()["id"].(string), "ready")
	if pe.ts.uploads != 1 {
		t.Fatalf("uploads %d", pe.ts.uploads)
	}
	// Prowlarr redirect to a magnet.
	rd := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "redir"}).Expect(201).JSON()
	pe.waitStatus(alice, rd["id"].(string), "ready")
	var hash string
	_ = pe.Pool.QueryRow(context.Background(), `SELECT info_hash FROM playback_sources WHERE id = $1`, rd["id"]).Scan(&hash)
	if hash != hashRedi {
		t.Fatalf("redirect hash %s", hash)
	}
	// A download URL pointing anywhere but Prowlarr is never fetched.
	before := len(pe.ts.requests())
	res := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "ssrf"}).Expect(502)
	pe.assertClean(res.Body)
	if res.ErrorCode() != "release_unavailable" {
		t.Fatal(res.ErrorCode())
	}
	for _, req := range pe.ts.requests()[before:] {
		if strings.Contains(req, "/settings") {
			t.Fatalf("SSRF: %s", req)
		}
	}
}

func TestPlaybackSeriesAndAuthorization(t *testing.T) {
	pe := newPlaybackEnv(t)
	alice, _ := pe.NewUserClient("alice", "user")
	bob, _ := pe.NewUserClient("bob", "user")
	aliceTVID, aliceTV := pe.Pair(alice, "Alice TV")
	_ = aliceTVID
	bobTVID, bobTVCred := pe.Pair(bob, "Bob TV")
	tvA, tvB := pe.Client(), pe.Client()
	tvA.Bearer, tvB.Bearer = aliceTV, bobTVCred

	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.showID, "release_id": "show"}).Expect(422)
	src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.showID, "release_id": "show", "episode_id": pe.episodes[2]}).Expect(201).JSON()
	id := src["id"].(string)
	if src["status"] != "ready" || src["file"].(map[string]any)["path"] != "Show.S01.1080p/Show.S01E02.1080p.mkv" ||
		src["file"].(map[string]any)["episode"].(float64) != 2 || src["episode_id"] != pe.episodes[2] {
		t.Fatalf("episode source: %v", src)
	}
	files := alice.Do("GET", "/api/v1/playback/sources/"+id+"/files", nil).Expect(200).Items()
	if files[2]["season"].(float64) != 1 || files[2]["episode"].(float64) != 3 || files[3]["episode"] != nil {
		t.Fatalf("files: %v", files)
	}

	// Episode 4 is not in the torrent → no_matching_file; a manual pick fixes it.
	e4 := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.showID, "release_id": "show", "episode_id": pe.episodes[4]}).Expect(201).JSON()
	if e4["status"] != "error" || e4["error"] != "no_matching_file" {
		t.Fatalf("e4: %v", e4)
	}
	fixed := alice.Do("PATCH", "/api/v1/playback/sources/"+e4["id"].(string), map[string]any{"file_index": 3}).Expect(200).JSON()
	if fixed["status"] != "ready" || fixed["error"] != nil || fixed["stream_url"] == nil {
		t.Fatalf("fixed: %v", fixed)
	}

	// Other users and their devices see nothing.
	bob.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(404)
	bob.Do("GET", "/api/v1/playback/sources/"+id+"/files", nil).Expect(404)
	bob.Do("PATCH", "/api/v1/playback/sources/"+id, map[string]any{"file_index": 1}).Expect(404)
	tvB.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(404)
	// Alice's own TV can read it.
	tvA.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200)
	// Bob shares his TV with Alice → Alice can cast her source to it.
	bob.Do("PUT", "/api/v1/devices/"+bobTVID+"/permissions", map[string]string{"username": "alice", "permission": "control"}).Expect(200)
	tvB.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200)

	// TV-created source: owned by the device owner, readable by that TV.
	tvSrc := tvB.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov"}).Expect(201).JSON()
	tvB.Do("GET", "/api/v1/playback/sources/"+tvSrc["id"].(string), nil).Expect(200)
	bob.Do("GET", "/api/v1/playback/sources/"+tvSrc["id"].(string), nil).Expect(200)
	alice.Do("GET", "/api/v1/playback/sources/"+tvSrc["id"].(string), nil).Expect(404)
	var devID *string
	_ = pe.Pool.QueryRow(context.Background(), `SELECT device_id FROM playback_sources WHERE id = $1`, tvSrc["id"]).Scan(&devID)
	if devID == nil || *devID != bobTVID {
		t.Fatalf("device id not recorded: %v", devID)
	}

	// Profiles must be accessible to the caller.
	var aliceProfile, bobProfile string
	ctx := context.Background()
	_ = pe.Pool.QueryRow(ctx, `INSERT INTO profiles (user_id, name) SELECT id, 'A' FROM users WHERE username = 'alice' RETURNING id`).Scan(&aliceProfile)
	_ = pe.Pool.QueryRow(ctx, `INSERT INTO profiles (user_id, name) SELECT id, 'B' FROM users WHERE username = 'bob' RETURNING id`).Scan(&bobProfile)
	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": bobProfile}).Expect(422)
	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": aliceProfile}).Expect(201)

	// API tokens: read may GET, write is needed to create.
	tok := alice.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "ro", "scopes": []string{"read"}}).Expect(201).JSON()["secret"].(string)
	ro := pe.Client()
	ro.Bearer = tok
	ro.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200)
	if code := ro.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov"}).Expect(403).ErrorCode(); code != "insufficient_scope" {
		t.Fatal(code)
	}
	// Anonymous.
	pe.Client().Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(401)
}

func TestPlaybackTorrServerDown(t *testing.T) {
	pe := newPlaybackEnv(t)
	alice, _ := pe.NewUserClient("alice", "user")
	src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov"}).Expect(201).JSON()
	stream := src["stream_url"].(string)

	pe.ts.srv.Close()
	res := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "slow"}).Expect(502)
	if res.ErrorCode() != "torrserver_unavailable" {
		t.Fatal(res.ErrorCode())
	}
	pe.assertClean(res.Body)
	// GET still works (no live stats).
	got := alice.Do("GET", "/api/v1/playback/sources/"+src["id"].(string), nil).Expect(200).JSON()
	if got["torrent"] != nil || got["status"] != "ready" {
		t.Fatalf("down get: %v", got)
	}
	r := pe.Client().Do("GET", stream, nil, "Range", "bytes=0-9").Expect(502)
	if r.ErrorCode() != "torrserver_unavailable" {
		t.Fatal(r.ErrorCode())
	}
	pe.assertClean(r.Body)
}

func TestPlaybackStreamClientDisconnectAbortsUpstream(t *testing.T) {
	pe := newPlaybackEnv(t)
	alice, _ := pe.NewUserClient("alice", "user")
	src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov"}).Expect(201).JSON()
	pe.ts.mu.Lock()
	pe.ts.endless, pe.ts.aborted = true, make(chan struct{})
	pe.ts.mu.Unlock()

	resp, err := http.Get(pe.BaseURL + src["stream_url"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || resp.Header.Get("Content-Length") != "" {
		t.Fatalf("status %d len %q", resp.StatusCode, resp.Header.Get("Content-Length"))
	}
	buf := make([]byte, 256<<10)
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close() // the player goes away
	select {
	case <-pe.ts.aborted:
	case <-time.After(10 * time.Second):
		t.Fatal("upstream stream was not aborted after the client disconnected")
	}
}

// Cancel while loading: a torrent this server just added for the source is
// removed again (and the source with it); one that was in TorrServer before
// (another app's) is never touched, only its preparation stops.
func TestPlaybackCancelWhileLoading(t *testing.T) {
	pe := newPlaybackEnv(t)
	alice, _ := pe.NewUserClient("alice", "user")
	tm := playback.DefaultTimings()
	tm.InlineWait, tm.MetadataTimeout, tm.PollInterval, tm.StatsTimeout = 50*time.Millisecond, 5*time.Second, 20*time.Millisecond, time.Second
	pe.Server.Playback.SetTimings(tm)
	pe.ts.setMetaAfter(hashDead, -1)
	pe.ts.setMetaAfter(hashSlow, -1)
	has := func(h string) bool {
		pe.ts.mu.Lock()
		defer pe.ts.mu.Unlock()
		return pe.ts.torrents[h] != nil
	}

	// Ours: added for this source → removed on cancel.
	src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "slow"}).Expect(201).JSON()
	if src["status"] != "preparing" || !has(hashSlow) {
		t.Fatalf("expected preparing: %v", src)
	}
	id := src["id"].(string)
	bob, _ := pe.NewUserClient("bob", "user")
	bob.Do("DELETE", "/api/v1/playback/sources/"+id, nil).Expect(404)
	alice.Do("DELETE", "/api/v1/playback/sources/"+id, nil).Expect(204)
	for i := 0; i < 100 && has(hashSlow); i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if has(hashSlow) {
		t.Fatal("torrent not removed")
	}
	alice.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(404)

	// Already in TorrServer (e.g. added by Lampa): kept.
	pe.ts.mu.Lock()
	pe.ts.torrents[hashDead] = &tsTorrent{hash: hashDead}
	pe.ts.mu.Unlock()
	dead := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "dead"}).Expect(201).JSON()
	alice.Do("DELETE", "/api/v1/playback/sources/"+dead["id"].(string), nil).Expect(204)
	time.Sleep(300 * time.Millisecond)
	if !has(hashDead) {
		t.Fatal("pre-existing torrent removed")
	}
	if got := alice.Do("GET", "/api/v1/playback/sources/"+dead["id"].(string), nil).Expect(200).JSON(); got["status"] == "error" {
		t.Fatalf("cancelled source marked failed: %v", got)
	}
}
