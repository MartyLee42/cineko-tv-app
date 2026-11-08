package server_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"martytv/api/internal/playback"
	"martytv/api/internal/testutil"
)

// Instant play (playback/warm.go): POST /playback/warm prepares the release
// Play would start; Play then gets that very source at once.

func warmSettings() playback.WarmSettings {
	s := playback.DefaultWarmSettings()
	s.Grace, s.Bridge, s.Hold = 50*time.Millisecond, 50*time.Millisecond, 2*time.Second
	return s
}

func newWarmEnv(t *testing.T) *playbackEnv {
	pe := newPlaybackEnv(t)
	pe.Server.Playback.SetWarmSettings(warmSettings())
	return pe
}

func (pe *playbackEnv) hasTorrent(h string) bool {
	pe.ts.mu.Lock()
	defer pe.ts.mu.Unlock()
	return pe.ts.torrents[h] != nil
}

// waitFor polls cond for up to 3 s.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for i := 0; i < 150; i++ {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func (pe *playbackEnv) count(q string, args ...any) int {
	pe.T.Helper()
	var n int
	if err := pe.Pool.QueryRow(context.Background(), q, args...).Scan(&n); err != nil {
		pe.T.Fatal(err)
	}
	return n
}

// headReads: /stream requests with a Range (the warm's head read).
func (pe *playbackEnv) headReads(hash string) int {
	pe.ts.mu.Lock()
	defer pe.ts.mu.Unlock()
	n := 0
	for i, q := range pe.ts.streams {
		if strings.Contains(q, "link="+hash) && strings.HasPrefix(pe.ts.ranges[i], "bytes=") {
			n++
		}
	}
	return n
}

func (pe *playbackEnv) adds() int {
	n := 0
	for _, r := range pe.ts.requests() {
		if strings.HasPrefix(r, "POST /torrents") {
			n++
		}
	}
	return n
}

func stat(pe *playbackEnv, k string) uint64 { return pe.Server.Playback.InstantPlayStats()[k] }

func TestInstantPlayWarmThenPlay(t *testing.T) {
	pe := newWarmEnv(t)
	alice, _ := pe.NewUserClient("alice", "user")
	prof := firstProfile(t, alice)

	res := alice.Do("POST", "/api/v1/playback/warm", map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": prof}).Expect(202).JSON()
	if res["status"] != "warming" || res["expires_at"] == nil {
		t.Fatalf("warm: %v", res)
	}
	waitFor(t, "head read", func() bool { return pe.headReads(hashMov) == 1 })
	if pe.count(`SELECT count(*) FROM playback_sources WHERE status = 'ready'`) != 1 {
		t.Fatal("warm source not ready")
	}
	// The same page again: no second warm.
	alice.Do("POST", "/api/v1/playback/warm", map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": prof}).Expect(202)
	if stat(pe, "started") != 1 {
		t.Fatalf("started = %d", stat(pe, "started"))
	}

	// Play: the warm source, ready at once, without asking TorrServer again.
	before := len(pe.ts.requests())
	t0 := time.Now()
	created := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": prof}).Expect(201)
	took := time.Since(t0)
	pe.assertClean(created.Body)
	src := created.JSON()
	if src["status"] != "ready" || src["stream_url"] == nil {
		t.Fatalf("play after warm: %v", src)
	}
	if after := pe.ts.requests()[before:]; len(after) != 0 {
		t.Fatalf("play asked TorrServer again: %v", after)
	}
	t.Logf("POST /playback/sources after warm: %v", took)
	if stat(pe, "hit") != 1 || stat(pe, "miss") != 0 {
		t.Fatalf("stats: %v", pe.Server.Playback.InstantPlayStats())
	}
	// Never history: no playback session, no progress.
	if n := pe.count(`SELECT (SELECT count(*) FROM playback_sessions) + (SELECT count(*) FROM watch_progress) + (SELECT count(*) FROM watch_events)`); n != 0 {
		t.Fatalf("warm left %d history rows", n)
	}
	// Played: kept after the warm ends.
	time.Sleep(200 * time.Millisecond)
	if !pe.hasTorrent(hashMov) {
		t.Fatal("played torrent removed")
	}
	// The stream works.
	r := alice.Do("GET", src["stream_url"].(string), nil).Expect(200)
	if len(r.Body) != len(pe.ts.payload) {
		t.Fatalf("stream: %d bytes", len(r.Body))
	}
}

// Cold vs warm Play against the mock TorrServer with slow metadata: the
// numbers are the mechanism's, not a real swarm's.
func TestInstantPlayColdVsWarm(t *testing.T) {
	pe := newWarmEnv(t)
	alice, _ := pe.NewUserClient("alice", "user")
	prof := firstProfile(t, alice)
	tm := playback.DefaultTimings()
	tm.InlineWait, tm.MetadataTimeout, tm.PollInterval, tm.StatsTimeout = 3*time.Second, 10*time.Second, 100*time.Millisecond, time.Second
	pe.Server.Playback.SetTimings(tm)

	// Cold: metadata after 10 polls (~1 s), Play waits for it inline.
	pe.ts.setMetaAfter(hashSlow, 10)
	t0 := time.Now()
	cold := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "slow", "profile_id": prof}).Expect(201).JSON()
	coldTook := time.Since(t0)
	if cold["status"] != "ready" {
		t.Fatalf("cold: %v", cold)
	}

	// Warm: the same delay happens while the title page is open.
	pe.ts.setMetaAfter(hashMov, 10)
	alice.Do("POST", "/api/v1/playback/warm", map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": prof}).Expect(202)
	waitFor(t, "head read", func() bool { return pe.headReads(hashMov) == 1 })
	t0 = time.Now()
	warm := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": prof}).Expect(201).JSON()
	warmTook := time.Since(t0)
	if warm["status"] != "ready" {
		t.Fatalf("warm: %v", warm)
	}
	t.Logf("Play → ready source: cold %v, warm %v", coldTook.Round(time.Millisecond), warmTook.Round(time.Millisecond))
	if warmTook >= coldTook {
		t.Fatalf("warm (%v) not faster than cold (%v)", warmTook, coldTook)
	}
}

func TestInstantPlaySkips(t *testing.T) {
	pe := newWarmEnv(t)
	alice, _ := pe.NewUserClient("alice", "user")
	admin, _ := pe.NewUserClient("root", "admin")
	bob, _ := pe.NewUserClient("bob", "user")
	prof := firstProfile(t, alice)
	warm := func(c *testutil.Client, body map[string]any) map[string]any {
		return c.Do("POST", "/api/v1/playback/warm", body).Expect(202).JSON()
	}
	reason := func(m map[string]any) string {
		if m["status"] != "skipped" {
			t.Fatalf("not skipped: %v", m)
		}
		return m["reason"].(string)
	}

	// Validation: profile required, someone else's profile, movie with an episode.
	alice.Do("POST", "/api/v1/playback/warm", map[string]any{"media_id": pe.movieID, "release_id": "mov"}).Expect(422)
	bob.Do("POST", "/api/v1/playback/warm", map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": prof}).Expect(422)
	alice.Do("POST", "/api/v1/playback/warm", map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": prof, "episode_id": pe.episodes[1]}).Expect(422)
	alice.Do("DELETE", "/api/v1/playback/warm", nil).Expect(422)

	if r := reason(warm(alice, map[string]any{"media_id": pe.movieID, "release_id": "nope", "profile_id": prof})); r != "no_release" {
		t.Fatal(r)
	}
	if r := reason(warm(alice, map[string]any{"media_id": pe.movieID, "release_id": "online:abc", "profile_id": prof})); r != "online" {
		t.Fatal(r)
	}
	// Busy server.
	set := warmSettings()
	set.BusyStreams = 0
	pe.Server.Playback.SetWarmSettings(set)
	if r := reason(warm(alice, map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": prof})); r != "busy" {
		t.Fatal(r)
	}
	pe.Server.Playback.SetWarmSettings(warmSettings())

	// Admin switch «Мгновенный старт».
	alice.Do("PUT", "/api/v1/admin/playback", map[string]any{"instant_play": false}).Expect(403)
	if on := admin.Do("GET", "/api/v1/admin/playback", nil).Expect(200).JSON()["instant_play"]; on != true {
		t.Fatalf("default: %v", on)
	}
	admin.Do("PUT", "/api/v1/admin/playback", map[string]any{}).Expect(422)
	admin.Do("PUT", "/api/v1/admin/playback", map[string]any{"instant_play": false}).Expect(200)
	if r := reason(warm(alice, map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": prof})); r != "disabled" {
		t.Fatal(r)
	}
	admin.Do("PUT", "/api/v1/admin/playback", map[string]any{"instant_play": true}).Expect(200)
	if pe.hasTorrent(hashMov) || pe.count(`SELECT count(*) FROM playback_sources`) != 0 {
		t.Fatal("a skipped warm touched TorrServer")
	}
	// Already downloaded to the server: plays from disk anyway.
	if _, err := pe.Pool.Exec(context.Background(), `INSERT INTO downloads (info_hash, file_index, file_path, size, status, bytes_done, completed_at)
		VALUES ($1, 1, 'Movie.mkv', 10, 'done', 10, now())`, hashMov); err != nil {
		t.Fatal(err)
	}
	if r := reason(warm(alice, map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": prof})); r != "local" {
		t.Fatal(r)
	}
	if stat(pe, "skipped") != 5 || stat(pe, "started") != 0 {
		t.Fatalf("stats: %v", pe.Server.Playback.InstantPlayStats())
	}
}

func TestInstantPlayLimitsCancelAndTTL(t *testing.T) {
	pe := newWarmEnv(t)
	tm := playback.DefaultTimings()
	tm.InlineWait, tm.MetadataTimeout, tm.PollInterval, tm.StatsTimeout = 50*time.Millisecond, 10*time.Second, 20*time.Millisecond, time.Second
	pe.Server.Playback.SetTimings(tm)
	pe.ts.setMetaAfter(hashSlow, -1)
	pe.ts.setMetaAfter(hashDead, -1)
	alice, _ := pe.NewUserClient("alice", "user")
	bob, _ := pe.NewUserClient("bob", "user")
	carol, _ := pe.NewUserClient("carol", "user")
	pa, pb, pc := firstProfile(t, alice), firstProfile(t, bob), firstProfile(t, carol)
	warm := func(c *testutil.Client, prof, release string) map[string]any {
		return c.Do("POST", "/api/v1/playback/warm", map[string]any{"media_id": pe.movieID, "release_id": release, "profile_id": prof}).Expect(202).JSON()
	}

	// Two per server: a third profile is skipped while both still prepare.
	if warm(alice, pa, "slow")["status"] != "warming" || warm(bob, pb, "dead")["status"] != "warming" {
		t.Fatal("warm not started")
	}
	if r := warm(carol, pc, "mov"); r["status"] != "skipped" || r["reason"] != "limit" {
		t.Fatalf("third warm: %v", r)
	}
	waitFor(t, "torrents added", func() bool { return pe.hasTorrent(hashSlow) && pe.hasTorrent(hashDead) })

	// A newer warm of the same profile replaces the previous one: its torrent
	// (added only for the warm) goes after the grace period.
	if warm(alice, pa, "mov")["status"] != "warming" {
		t.Fatal("replacement not started")
	}
	waitFor(t, "replaced torrent removed", func() bool { return !pe.hasTorrent(hashSlow) })
	if stat(pe, "cancelled") != 1 {
		t.Fatalf("stats: %v", pe.Server.Playback.InstantPlayStats())
	}

	// Leaving the page: cancelled; a torrent that was in TorrServer before stays.
	bob.Do("DELETE", "/api/v1/playback/warm?profile_id="+pb, nil).Expect(204)
	waitFor(t, "cancelled torrent removed", func() bool { return !pe.hasTorrent(hashDead) })
	if pe.count(`SELECT count(*) FROM playback_sources WHERE info_hash = $1`, hashDead) != 0 {
		t.Fatal("cancelled warm's source kept")
	}
	pe.ts.mu.Lock()
	pe.ts.torrents[hashDead] = &tsTorrent{hash: hashDead} // added by another app
	pe.ts.mu.Unlock()
	warm(bob, pb, "dead")
	waitFor(t, "source created", func() bool {
		return pe.count(`SELECT count(*) FROM playback_sources WHERE info_hash = $1`, hashDead) == 1
	})
	bob.Do("DELETE", "/api/v1/playback/warm?profile_id="+pb, nil).Expect(204)
	time.Sleep(300 * time.Millisecond)
	if !pe.hasTorrent(hashDead) {
		t.Fatal("pre-existing torrent removed")
	}

	// Play right after leaving (within the grace period) still gets it.
	waitFor(t, "alice's warm ready", func() bool { return pe.headReads(hashMov) == 1 })
	alice.Do("DELETE", "/api/v1/playback/warm?profile_id="+pa, nil).Expect(204)
	if src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": pa}).Expect(201).JSON(); src["status"] != "ready" {
		t.Fatalf("play within grace: %v", src)
	}
	time.Sleep(300 * time.Millisecond)
	if !pe.hasTorrent(hashMov) {
		t.Fatal("played torrent removed")
	}

	// TTL: an unplayed warm expires and is dropped.
	set := warmSettings()
	set.TTL = 300 * time.Millisecond
	pe.Server.Playback.SetWarmSettings(set)
	warm(carol, pc, "slow")
	waitFor(t, "torrent added", func() bool { return pe.hasTorrent(hashSlow) })
	waitFor(t, "expired torrent removed", func() bool { return !pe.hasTorrent(hashSlow) })
	if stat(pe, "expired") != 1 {
		t.Fatalf("stats: %v", pe.Server.Playback.InstantPlayStats())
	}
}

// Play with another release than the warm one: a miss, and the warm goes.
func TestInstantPlayMiss(t *testing.T) {
	pe := newWarmEnv(t)
	pe.ts.setMetaAfter(hashSlow, -1)
	alice, _ := pe.NewUserClient("alice", "user")
	bob, _ := pe.NewUserClient("bob", "user")
	prof := firstProfile(t, alice)
	alice.Do("POST", "/api/v1/playback/warm", map[string]any{"media_id": pe.movieID, "release_id": "slow", "profile_id": prof}).Expect(202)
	waitFor(t, "torrent added", func() bool { return pe.hasTorrent(hashSlow) })
	waitFor(t, "source created", func() bool {
		return pe.count(`SELECT count(*) FROM playback_sources WHERE info_hash = $1`, hashSlow) == 1
	})

	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": prof}).Expect(201)
	if stat(pe, "miss") != 1 || stat(pe, "hit") != 0 {
		t.Fatalf("stats: %v", pe.Server.Playback.InstantPlayStats())
	}
	waitFor(t, "missed warm dropped", func() bool { return !pe.hasTorrent(hashSlow) })

	// Someone else's Play of the same release never takes alice's warm.
	alice.Do("POST", "/api/v1/playback/warm", map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": prof}).Expect(202)
	waitFor(t, "head read", func() bool { return pe.headReads(hashMov) == 1 })
	bob.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov"}).Expect(201)
	if stat(pe, "hit") != 0 || stat(pe, "miss") != 1 {
		t.Fatalf("bob took alice's warm: %v", pe.Server.Playback.InstantPlayStats())
	}
}

// «Продолжить»: warm the source last watched with, at the resume point.
func TestInstantPlayResumeSource(t *testing.T) {
	pe := newWarmEnv(t)
	alice, _ := pe.NewUserClient("alice", "user")
	bob, _ := pe.NewUserClient("bob", "user")
	prof := firstProfile(t, alice)
	src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov", "profile_id": prof}).Expect(201).JSON()
	id := src["id"].(string)
	if _, err := pe.Pool.Exec(context.Background(), `UPDATE playback_sources SET media_info = '{"duration_seconds": 100}' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	bob.Do("POST", "/api/v1/playback/warm", map[string]any{"media_id": pe.movieID, "source_id": id, "profile_id": firstProfile(t, bob)}).Expect(404)
	alice.Do("POST", "/api/v1/playback/warm", map[string]any{"media_id": pe.movieID, "source_id": id, "profile_id": prof, "start_seconds": 50}).Expect(202)
	waitFor(t, "head read", func() bool { return pe.headReads(hashMov) == 1 })
	// Half-way into the 256 KiB mock file, less the 4 MiB margin: from 0.
	if _, r := pe.ts.lastStream(); r != "bytes=0-" {
		t.Fatalf("range %q", r)
	}
	alice.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200)
	if stat(pe, "hit") != 1 {
		t.Fatalf("stats: %v", pe.Server.Playback.InstantPlayStats())
	}
}

func TestInstantPlaySeriesEpisode(t *testing.T) {
	pe := newWarmEnv(t)
	alice, _ := pe.NewUserClient("alice", "user")
	prof := firstProfile(t, alice)
	alice.Do("POST", "/api/v1/playback/warm", map[string]any{"media_id": pe.showID, "release_id": "show", "profile_id": prof}).Expect(422) // episode required
	alice.Do("POST", "/api/v1/playback/warm", map[string]any{"media_id": pe.showID, "episode_id": pe.episodes[2], "release_id": "show", "profile_id": prof}).Expect(202)
	waitFor(t, "head read", func() bool { return pe.headReads(hashShow) == 1 })
	// Another episode of the same pack is not the warm one.
	if src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.showID, "episode_id": pe.episodes[3], "release_id": "show", "profile_id": prof}).Expect(201).JSON(); src["episode_id"] != pe.episodes[3] {
		t.Fatalf("episode 3: %v", src)
	}
	if stat(pe, "hit") != 0 || stat(pe, "miss") != 0 {
		t.Fatalf("stats: %v", pe.Server.Playback.InstantPlayStats())
	}
	src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.showID, "episode_id": pe.episodes[2], "release_id": "show", "profile_id": prof}).Expect(201).JSON()
	f, _ := src["file"].(map[string]any)
	if src["status"] != "ready" || f == nil || f["episode"] != float64(2) || stat(pe, "hit") != 1 {
		t.Fatalf("episode 2: %v / %v", src, pe.Server.Playback.InstantPlayStats())
	}
}
