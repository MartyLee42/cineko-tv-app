package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/downloads"
	"martytv/api/internal/testutil"
)

const gib = int64(1) << 30

type downloadsEnv struct {
	*playbackEnv
	dir  string
	free atomic.Int64
}

// newDownloadsEnv: playback env + a library in a temp dir, a fake disk
// (200 GiB, 100 GiB free unless changed) and the worker running fast.
func newDownloadsEnv(t *testing.T, opts ...testutil.Options) *downloadsEnv {
	dir := t.TempDir()
	pe := newPlaybackEnv(t, append([]testutil.Options{func(c *config.Config) {
		c.Library.Dir = dir
		c.Library.MaxJobs = 2
	}}, opts...)...)
	de := &downloadsEnv{playbackEnv: pe, dir: dir}
	de.free.Store(100 * gib)
	dl := pe.Server.Downloads
	dl.DiskStats = func(string) (downloads.DiskStats, error) {
		return downloads.DiskStats{Total: 200 * gib, Free: de.free.Load()}, nil
	}
	tm := downloads.DefaultTimings()
	tm.CheckpointBytes, tm.CheckpointEvery, tm.Idle = 32<<10, 50*time.Millisecond, 3*time.Second
	tm.BackoffBase, tm.BackoffMax, tm.MaxFailures = 50*time.Millisecond, 200*time.Millisecond, 3
	tm.Tick, tm.EventEvery, tm.WatchedEvery = 100*time.Millisecond, 50*time.Millisecond, time.Hour
	dl.SetTimings(tm)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { dl.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done; dl.Wait() })
	return de
}

func (de *downloadsEnv) waitDownload(c *testutil.Client, id, want string) map[string]any {
	de.T.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for {
		got := c.Do("GET", "/api/v1/downloads/"+id, nil).Expect(200).JSON()
		if got["status"] == want {
			return got
		}
		if time.Now().After(deadline) {
			de.T.Fatalf("download %s: status %v (error %v), want %s", id, got["status"], got["error"], want)
		}
		time.Sleep(30 * time.Millisecond)
	}
}

func (de *downloadsEnv) streamCount() int {
	de.ts.mu.Lock()
	defer de.ts.mu.Unlock()
	return len(de.ts.streams)
}

func (de *downloadsEnv) auditCount(action string) int {
	var n int
	if err := de.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events WHERE action = $1`, action).Scan(&n); err != nil {
		de.T.Fatal(err)
	}
	return n
}

func TestDownloadLifecycleAndPlayFromDisk(t *testing.T) {
	de := newDownloadsEnv(t)
	alice, _ := de.NewUserClient("alice", "user")
	bob, _ := de.NewUserClient("bob", "user")
	ws := dialUser(t, de.Env, alice)

	src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": de.movieID, "release_id": "mov"}).Expect(201).JSON()
	if src["download"] != nil {
		t.Fatalf("download before any request: %v", src["download"])
	}
	// Validation / unknown source / someone else's source.
	alice.Do("POST", "/api/v1/downloads", map[string]any{"source_id": "nope"}).Expect(422)
	bob.Do("POST", "/api/v1/downloads", map[string]any{"source_id": src["id"]}).Expect(404)
	de.Client().Do("GET", "/api/v1/downloads", nil).Expect(401)

	res := alice.Do("POST", "/api/v1/downloads", map[string]any{"source_id": src["id"]}).Expect(201)
	de.assertClean(res.Body)
	items := res.Items()
	if len(items) != 1 || items[0]["size"].(float64) != float64(len(de.ts.payload)) || items[0]["file_name"] != "Movie.2010.1080p.mkv" ||
		items[0]["mine"] != true || items[0]["info_hash"] != hashMov || items[0]["media_id"] != de.movieID {
		t.Fatalf("created: %s", res.Body)
	}
	id := items[0]["id"].(string)
	d := de.waitDownload(alice, id, "done")
	if d["progress"].(float64) != 1 || d["completed_at"] == nil || d["keep_until"] == nil || d["error"] != nil {
		t.Fatalf("done: %v", d)
	}
	ku, _ := time.Parse(time.RFC3339, d["keep_until"].(string))
	if until := time.Until(ku); until < 29*24*time.Hour || until > 31*24*time.Hour {
		t.Fatalf("keep_until %v", ku)
	}
	// The file is complete on disk under <library>/<hash>/<index>.<ext>.
	onDisk, err := os.ReadFile(filepath.Join(de.dir, hashMov, "1.mkv"))
	if err != nil || !bytes.Equal(onDisk, de.ts.payload) {
		t.Fatalf("file on disk: %v (%d bytes)", err, len(onDisk))
	}
	if _, err := os.Stat(filepath.Join(de.dir, hashMov, "1.part")); !os.IsNotExist(err) {
		t.Fatal("part file left behind")
	}
	// The worker read with Range through TorrServer's stream endpoint.
	_, rng := de.ts.lastStream()
	if !strings.HasPrefix(rng, "bytes=") {
		t.Fatalf("range %q", rng)
	}

	// Realtime: progress/status events for the requester, ending in done.
	deadline := time.After(3 * time.Second)
	for done := false; !done; {
		select {
		case <-deadline:
			t.Fatal("no download.updated done event")
		default:
		}
		m := ws.expect("download.updated")
		var p map[string]any
		_ = json.Unmarshal(m.Payload, &p)
		done = p["id"] == id && p["status"] == "done"
	}

	// The playback source reports the download and plays from disk.
	got := alice.Do("GET", "/api/v1/playback/sources/"+src["id"].(string), nil).Expect(200).JSON()
	dl, _ := got["download"].(map[string]any)
	if dl == nil || dl["status"] != "done" || dl["id"] != id || dl["mine"] != true || dl["keep_until"] == nil {
		t.Fatalf("source.download: %v", got["download"])
	}
	if got["torrent"] != nil {
		t.Fatalf("downloaded file should not wake the torrent: %v", got["torrent"])
	}
	stream := got["stream_url"].(string)
	before := de.streamCount()
	anon := de.Client()
	r := anon.Do("GET", stream, nil, "Range", "bytes=100-199").Expect(206)
	if !bytes.Equal(r.Body, de.ts.payload[100:200]) || r.Header.Get("Content-Range") != "bytes 100-199/"+strconv.Itoa(len(de.ts.payload)) ||
		r.Header.Get("Content-Type") != "video/x-matroska" || r.Header.Get("Accept-Ranges") != "bytes" || r.Header.Get("ETag") == "" {
		t.Fatalf("range from disk: %d %v", len(r.Body), r.Header)
	}
	etag := r.Header.Get("ETag")
	r = anon.Do("GET", stream+"/Movie.mkv", nil).Expect(200)
	if !bytes.Equal(r.Body, de.ts.payload) {
		t.Fatal("full body from disk differs")
	}
	// If-Range: matching validator → 206; stale → whole file.
	anon.Do("GET", stream, nil, "Range", "bytes=0-9", "If-Range", etag).Expect(206)
	if r = anon.Do("GET", stream, nil, "Range", "bytes=0-9", "If-Range", `"stale"`).Expect(200); len(r.Body) != len(de.ts.payload) {
		t.Fatal("If-Range mismatch must send the whole file")
	}
	anon.Do("GET", stream, nil, "Range", "bytes=99999999-").Expect(416)
	r = anon.Do("HEAD", stream, nil, "Range", "bytes=10-19").Expect(206)
	if r.Header.Get("Content-Length") != "10" || len(r.Body) != 0 {
		t.Fatalf("HEAD: %v", r.Header)
	}
	if de.streamCount() != before {
		t.Fatal("a downloaded file must not be streamed from TorrServer")
	}
	// Auth: a bad token is still refused.
	anon.Do("GET", "/api/v1/stream/AAAA", nil).Expect(403)
	// Playing touched last_watched_at.
	for i := 0; ; i++ {
		var lw *time.Time
		_ = de.Pool.QueryRow(context.Background(), `SELECT last_watched_at FROM downloads WHERE id = $1`, id).Scan(&lw)
		if lw != nil {
			break
		}
		if i > 100 {
			t.Fatal("last_watched_at not set")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Ownership: bob can't see alice's download…
	bob.Do("GET", "/api/v1/downloads/"+id, nil).Expect(404)
	bob.Do("DELETE", "/api/v1/downloads/"+id, nil).Expect(404)
	bob.Do("PATCH", "/api/v1/downloads/"+id, map[string]any{"pinned": true}).Expect(404)
	if n := len(bob.Do("GET", "/api/v1/downloads", nil).Expect(200).Items()); n != 0 {
		t.Fatalf("bob sees %d downloads", n)
	}
	bob.Do("GET", "/api/v1/downloads?all=true", nil).Expect(403)
	// …but his own source of the same file is ready at once and plays from disk.
	bsrc := bob.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": de.movieID, "release_id": "mov"}).Expect(201).JSON()
	bdl, _ := bsrc["download"].(map[string]any)
	if bsrc["status"] != "ready" || bdl == nil || bdl["status"] != "done" || bdl["mine"] != false {
		t.Fatalf("bob's source: %v / %v", bsrc["status"], bsrc["download"])
	}
	before = de.streamCount()
	if r := anon.Do("GET", bsrc["stream_url"].(string), nil, "Range", "bytes=0-99").Expect(206); !bytes.Equal(r.Body, de.ts.payload[:100]) {
		t.Fatal("bob's stream")
	}
	if de.streamCount() != before {
		t.Fatal("bob's stream went to TorrServer")
	}

	// Bob asks for it too: same download, now his as well.
	bi := bob.Do("POST", "/api/v1/downloads", map[string]any{"source_id": bsrc["id"]}).Expect(201).Items()
	if bi[0]["id"] != id || bi[0]["status"] != "done" || bi[0]["mine"] != true {
		t.Fatalf("bob reuse: %v", bi[0])
	}
	// Pin / pause.
	p := alice.Do("PATCH", "/api/v1/downloads/"+id, map[string]any{"pinned": true}).Expect(200).JSON()
	if p["pinned"] != true || p["keep_until"] != nil {
		t.Fatalf("pin: %v", p)
	}
	alice.Do("PATCH", "/api/v1/downloads/"+id, map[string]any{}).Expect(422)

	// Bob deletes: only his request goes; the file stays for alice.
	bob.Do("DELETE", "/api/v1/downloads/"+id, nil).Expect(204)
	bob.Do("GET", "/api/v1/downloads/"+id, nil).Expect(404)
	if _, err := os.Stat(filepath.Join(de.dir, hashMov, "1.mkv")); err != nil {
		t.Fatal("file removed while alice still wants it")
	}
	// Alice deletes: the file goes; playback falls back to TorrServer.
	alice.Do("DELETE", "/api/v1/downloads/"+id, nil).Expect(204)
	ws.expect("download.removed")
	alice.Do("GET", "/api/v1/downloads/"+id, nil).Expect(404)
	if _, err := os.Stat(filepath.Join(de.dir, hashMov)); !os.IsNotExist(err) {
		t.Fatal("library dir for the torrent not cleaned up")
	}
	before = de.streamCount()
	anon.Do("GET", stream, nil, "Range", "bytes=0-9").Expect(206)
	if de.streamCount() != before+1 {
		t.Fatal("after delete the stream should come from TorrServer again")
	}
	if de.auditCount("downloads.created") != 2 || de.auditCount("downloads.deleted") != 2 {
		t.Fatalf("audit: created %d deleted %d", de.auditCount("downloads.created"), de.auditCount("downloads.deleted"))
	}
}

func TestDownloadSizeMismatchFails(t *testing.T) {
	de := newDownloadsEnv(t)
	// The torrent claims a bigger file than TorrServer serves.
	de.ts.setFiles(hashMov, []tsFile{{1, "Movie.2010.1080p/Movie.2010.1080p.mkv", int64(len(de.ts.payload)) + 5000}})
	alice, _ := de.NewUserClient("alice", "user")
	src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": de.movieID, "release_id": "mov"}).Expect(201).JSON()
	id := alice.Do("POST", "/api/v1/downloads", map[string]any{"source_id": src["id"]}).Expect(201).Items()[0]["id"].(string)
	d := de.waitDownload(alice, id, "failed")
	if d["error"] != "size_mismatch" {
		t.Fatalf("error %v", d["error"])
	}
	if entries, _ := os.ReadDir(filepath.Join(de.dir, hashMov)); len(entries) != 0 {
		t.Fatalf("partial file kept: %v", entries)
	}
	// The stream still comes from TorrServer.
	got := alice.Do("GET", "/api/v1/playback/sources/"+src["id"].(string), nil).Expect(200).JSON()
	if dl := got["download"].(map[string]any); dl["status"] != "failed" {
		t.Fatalf("source.download %v", dl)
	}
	// Online sources / not-ready sources can't be downloaded.
	var onlineID string
	_ = de.Pool.QueryRow(context.Background(), `INSERT INTO playback_sources (media_id, release_id, release, kind, provider, created_by_user_id, status)
		SELECT $1, 'o1', '{}', 'online', 'anilibria', id, 'ready' FROM users WHERE username = 'alice' RETURNING id`, de.movieID).Scan(&onlineID)
	if onlineID != "" {
		if code := alice.Do("POST", "/api/v1/downloads", map[string]any{"source_id": onlineID}).Expect(422).ErrorCode(); code != "not_a_torrent" {
			t.Fatal(code)
		}
	}
	slow := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": de.movieID, "release_id": "slow"}).Expect(201).JSON()
	if slow["status"] == "preparing" {
		if code := alice.Do("POST", "/api/v1/downloads", map[string]any{"source_id": slow["id"]}).Expect(409).ErrorCode(); code != "source_not_ready" {
			t.Fatal(code)
		}
	}
}

// insertDone adds a completed download (with its file) directly.
func (de *downloadsEnv) insertDone(hash string, size int64, completedDaysAgo int, pinned bool) string {
	de.T.Helper()
	var id string
	if err := de.Pool.QueryRow(context.Background(), `INSERT INTO downloads (info_hash, file_index, file_path, size, status, bytes_done, pinned, completed_at)
		VALUES ($1, 1, 'Old.mkv', $2, 'done', $2, $3, now() - make_interval(days => $4)) RETURNING id`, hash, size, pinned, completedDaysAgo).Scan(&id); err != nil {
		de.T.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(de.dir, hash), 0o750); err != nil {
		de.T.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(de.dir, hash, "1.mkv"), make([]byte, size), 0o640); err != nil {
		de.T.Fatal(err)
	}
	return id
}

func TestDownloadEvictionAndWaitingSpace(t *testing.T) {
	de := newDownloadsEnv(t)
	admin, _ := de.NewUserClient("root", "admin")
	alice, _ := de.NewUserClient("alice", "user")
	reserve := 15 * gib
	size := int64(len(de.ts.payload))
	old := de.insertDone(strings.Repeat("a", 40), 300_000, 40, false)
	young := de.insertDone(strings.Repeat("b", 40), 900_000, 5, false)
	pinned := de.insertDone(strings.Repeat("c", 40), 900_000, 90, true)

	// Only 100 bytes above the reserve: the old download has to go.
	de.free.Store(reserve + 100)
	src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": de.movieID, "release_id": "mov"}).Expect(201).JSON()
	id := alice.Do("POST", "/api/v1/downloads", map[string]any{"source_id": src["id"]}).Expect(201).Items()[0]["id"].(string)
	de.waitDownload(alice, id, "done")
	admin.Do("GET", "/api/v1/downloads/"+old, nil).Expect(404)
	if _, err := os.Stat(filepath.Join(de.dir, strings.Repeat("a", 40))); !os.IsNotExist(err) {
		t.Fatal("evicted file still on disk")
	}
	admin.Do("GET", "/api/v1/downloads/"+young, nil).Expect(200)
	admin.Do("GET", "/api/v1/downloads/"+pinned, nil).Expect(200)
	if de.auditCount("downloads.evicted") != 1 {
		t.Fatal("eviction not audited")
	}

	// No room and nothing old enough (young < keep_days, pinned): waits.
	de.free.Store(reserve)
	show := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": de.showID, "release_id": "show", "episode_id": de.episodes[1]}).Expect(201).JSON()
	show = de.waitStatus(alice, show["id"].(string), "ready")
	sid := alice.Do("POST", "/api/v1/downloads", map[string]any{"source_id": show["id"]}).Expect(201).Items()[0]["id"].(string)
	w := de.waitDownload(alice, sid, "waiting_space")
	if w["error"] != "insufficient_space" || w["space_needed_bytes"].(float64) != float64(size) {
		t.Fatalf("waiting: %v", w)
	}
	admin.Do("GET", "/api/v1/downloads/"+young, nil).Expect(200)
	admin.Do("GET", "/api/v1/downloads/"+pinned, nil).Expect(200)
	st := admin.Do("GET", "/api/v1/admin/storage", nil).Expect(200).JSON()
	if st["available_bytes"].(float64) != 0 || st["counts"].(map[string]any)["waiting_space"].(float64) != 1 {
		t.Fatalf("storage: %v", st)
	}
	// Space appears → it continues on its own.
	de.free.Store(reserve + gib)
	de.waitDownload(alice, sid, "done")

	// Season: queues the other episode files of the pack (not extras).
	items := alice.Do("POST", "/api/v1/downloads", map[string]any{"source_id": show["id"], "season": true}).Expect(201).Items()
	eps := map[float64]bool{}
	for _, it := range items {
		if it["episode"] != nil {
			eps[it["episode"].(float64)] = true
		}
		if strings.Contains(it["file_name"].(string), "Extras") {
			t.Fatal("extras queued")
		}
	}
	if len(items) != 3 || !eps[1] || !eps[2] || !eps[3] || items[0]["id"] != sid {
		t.Fatalf("season: %d items %v", len(items), eps)
	}
	for _, it := range items {
		de.waitDownload(alice, it["id"].(string), "done")
	}
	if n := len(alice.Do("GET", "/api/v1/downloads?media_id="+de.showID, nil).Expect(200).Items()); n != 3 {
		t.Fatalf("filter media_id: %d", n)
	}
	// Pause/resume on a queued one.
	all := admin.Do("GET", "/api/v1/downloads?all=true", nil).Expect(200).Items()
	if len(all) != 6 || all[0]["users"] == nil {
		t.Fatalf("admin list: %d", len(all))
	}
}

func TestDownloadPauseResume(t *testing.T) {
	de := newDownloadsEnv(t)
	alice, _ := de.NewUserClient("alice", "user")
	de.free.Store(1) // below the reserve: stays waiting
	src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": de.movieID, "release_id": "mov"}).Expect(201).JSON()
	id := alice.Do("POST", "/api/v1/downloads", map[string]any{"source_id": src["id"]}).Expect(201).Items()[0]["id"].(string)
	de.waitDownload(alice, id, "waiting_space")
	if p := alice.Do("PATCH", "/api/v1/downloads/"+id, map[string]any{"paused": true}).Expect(200).JSON(); p["status"] != "paused" {
		t.Fatalf("pause: %v", p["status"])
	}
	de.free.Store(100 * gib)
	time.Sleep(300 * time.Millisecond)
	if d := alice.Do("GET", "/api/v1/downloads/"+id, nil).Expect(200).JSON(); d["status"] != "paused" {
		t.Fatalf("paused download started: %v", d["status"])
	}
	alice.Do("PATCH", "/api/v1/downloads/"+id, map[string]any{"paused": false}).Expect(200)
	de.waitDownload(alice, id, "done")
}

func TestAdminStorageSettings(t *testing.T) {
	de := newDownloadsEnv(t)
	admin, _ := de.NewUserClient("root", "admin")
	alice, _ := de.NewUserClient("alice", "user")
	alice.Do("GET", "/api/v1/admin/storage", nil).Expect(403)
	alice.Do("PATCH", "/api/v1/admin/storage", map[string]any{"keep_days": 5}).Expect(403)

	st := admin.Do("GET", "/api/v1/admin/storage", nil).Expect(200).JSON()
	set := st["settings"].(map[string]any)
	if set["reserve_gb"].(float64) != 15 || set["max_library_gb"] != nil || set["keep_days"].(float64) != 30 || st["ok"] != true ||
		st["disk_total_bytes"].(float64) != float64(200*gib) || st["reserve_bytes"].(float64) != float64(15*gib) ||
		st["available_bytes"].(float64) != float64(85*gib) || st["max_jobs"].(float64) != 2 {
		t.Fatalf("defaults: %v", st)
	}
	admin.Do("PATCH", "/api/v1/admin/storage", map[string]any{"keep_days": 0}).Expect(422)
	admin.Do("PATCH", "/api/v1/admin/storage", map[string]any{"reserve_gb": "x"}).Expect(422)
	admin.Do("PATCH", "/api/v1/admin/storage", map[string]any{"nope": 1}).Expect(422)
	st = admin.Do("PATCH", "/api/v1/admin/storage", map[string]any{"reserve_gb": 20, "max_library_gb": 50, "keep_days": 45}).Expect(200).JSON()
	set = st["settings"].(map[string]any)
	if set["reserve_gb"].(float64) != 20 || set["max_library_gb"].(float64) != 50 || set["keep_days"].(float64) != 45 ||
		st["available_bytes"].(float64) != float64(50*gib) {
		t.Fatalf("updated: %v", st)
	}
	st = admin.Do("PATCH", "/api/v1/admin/storage", map[string]any{"max_library_gb": nil}).Expect(200).JSON()
	if st["settings"].(map[string]any)["max_library_gb"] != nil || st["settings"].(map[string]any)["keep_days"].(float64) != 45 {
		t.Fatalf("unset cap: %v", st["settings"])
	}
	if de.auditCount("storage.updated") != 2 {
		t.Fatal("storage settings not audited")
	}
}

func TestAdminTorrServerTorrents(t *testing.T) {
	de := newDownloadsEnv(t)
	de.ts.mu.Lock()
	de.ts.listTorrents = true
	de.ts.mu.Unlock()
	admin, _ := de.NewUserClient("root", "admin")
	alice, _ := de.NewUserClient("alice", "user")
	alice.Do("GET", "/api/v1/admin/torrserver/torrents", nil).Expect(403)
	alice.Do("DELETE", "/api/v1/admin/torrserver/torrents/"+hashMov, nil).Expect(403)

	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": de.movieID, "release_id": "mov"}).Expect(201)
	show := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": de.showID, "release_id": "show", "episode_id": de.episodes[2]}).Expect(201).JSON()
	show = de.waitStatus(alice, show["id"].(string), "ready")
	// A download waiting for space holds the show torrent.
	de.free.Store(1)
	alice.Do("POST", "/api/v1/downloads", map[string]any{"source_id": show["id"]}).Expect(201)

	byHash := func() map[string]map[string]any {
		out := map[string]map[string]any{}
		res := admin.Do("GET", "/api/v1/admin/torrserver/torrents", nil).Expect(200)
		de.assertClean(res.Body)
		for _, it := range res.Items() {
			out[it["hash"].(string)] = it
		}
		return out
	}
	deadline := time.Now().Add(5 * time.Second)
	var list map[string]map[string]any
	for {
		list = byHash()
		if u := list[hashShow]["martytv"].(map[string]any); u["download"] != nil && u["download"].(map[string]any)["status"] == "waiting_space" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("show usage: %v", list[hashShow])
		}
		time.Sleep(50 * time.Millisecond)
	}
	mov := list[hashMov]
	mu := mov["martytv"].(map[string]any)
	if mov["title"] == "" || mov["size_bytes"].(float64) != 123456 || mov["added_at"] == nil || mov["stat_string"] == "" ||
		mu["sources"].(float64) != 1 || mu["in_use"] != false || mu["streaming"] != false {
		t.Fatalf("movie torrent: %v", mov)
	}
	if su := list[hashShow]["martytv"].(map[string]any); su["in_use"] != true {
		t.Fatalf("show torrent: %v", su)
	}

	// In use → 409 unless forced; idle ones go at once. Every removal is audited.
	if code := admin.Do("DELETE", "/api/v1/admin/torrserver/torrents/"+hashShow, nil).Expect(409).ErrorCode(); code != "torrent_in_use" {
		t.Fatal(code)
	}
	admin.Do("DELETE", "/api/v1/admin/torrserver/torrents/"+hashMov, nil).Expect(204)
	admin.Do("DELETE", "/api/v1/admin/torrserver/torrents/"+hashShow+"?force=true", nil).Expect(204)
	admin.Do("DELETE", "/api/v1/admin/torrserver/torrents/"+hashMov, nil).Expect(404)
	admin.Do("DELETE", "/api/v1/admin/torrserver/torrents/NOT-A-HASH", nil).Expect(404)
	if l := byHash(); len(l) != 0 {
		t.Fatalf("left in TorrServer: %v", l)
	}
	if de.auditCount("torrserver.removed") != 2 {
		t.Fatal("removals not audited")
	}
	// Only list/get/add/rem were used: no settings or other routes.
	for _, r := range de.ts.requests() {
		if strings.Contains(r, "/settings") || strings.Contains(r, "/shutdown") || strings.Contains(r, "/storage") {
			t.Fatalf("touched %s", r)
		}
	}
}

func TestDownloadedCompatReadsLocalFile(t *testing.T) {
	tc := newFakeTranscoder(t)
	de := newDownloadsEnv(t, func(c *config.Config) {
		c.Transcoder = config.TranscoderConfig{URL: tc.srv.URL, Secret: tcSecret}
	})
	de.Config.Library.InternalURL = de.BaseURL // the transcoder reaches the API here
	alice, _ := de.NewUserClient("alice", "user")
	src := readySource(t, de.playbackEnv, alice)
	id := alice.Do("POST", "/api/v1/downloads", map[string]any{"source_id": src["id"]}).Expect(201).Items()[0]["id"].(string)
	de.waitDownload(alice, id, "done")
	src = alice.Do("GET", "/api/v1/playback/sources/"+src["id"].(string), nil).Expect(200).JSON()
	de.Client().Do("GET", src["compat_url"].(string), nil).Expect(200)
	job := tc.last()
	in, _ := job["input"].(string)
	auth, _ := job["auth"].(string)
	if !strings.HasPrefix(in, de.BaseURL+"/api/v1/stream/") || !strings.HasSuffix(in, "/local.mkv") || !strings.HasPrefix(auth, "MartyTV-Internal ") {
		t.Fatalf("compat job input %q auth %q", in, auth)
	}
	// The transcoder's read is served from disk (Range works).
	before := de.streamCount()
	r := de.Client().Do("GET", strings.TrimPrefix(in, de.BaseURL), nil, "Range", "bytes=5-9", "Authorization", auth).Expect(206)
	if !bytes.Equal(r.Body, de.ts.payload[5:10]) || de.streamCount() != before {
		t.Fatal("internal read not from disk")
	}
}
