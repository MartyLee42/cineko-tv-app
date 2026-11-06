package sourcesapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/sources"
	"martytv/api/internal/sources/cdnvideohub"
	"martytv/api/internal/sources/collaps"
	"martytv/api/internal/testutil"
)

func newMockTMDB(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ru := r.URL.Query().Get("language") == "ru-RU"
		var body any
		switch r.URL.Path {
		case "/movie/603":
			title := "The Matrix"
			if ru {
				title = "Матрица"
			}
			body = map[string]any{"id": 603, "title": title, "original_title": "The Matrix", "original_language": "en",
				"release_date": "1999-03-31", "genres": []map[string]any{{"id": 878, "name": "SF"}},
				"external_ids": map[string]any{"imdb_id": "tt0133093"}}
		case "/tv/1399":
			body = map[string]any{"id": 1399, "name": "Game of Thrones", "original_name": "Game of Thrones", "original_language": "en",
				"first_air_date": "2011-04-17", "number_of_seasons": 1, "external_ids": map[string]any{"imdb_id": "tt0944947"},
				"seasons": []map[string]any{{"season_number": 1, "episode_count": 10, "name": "Season 1"}}}
		default:
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func setup(t *testing.T) (*testutil.Env, *sources.FakeOnline, *sources.FakeOnline) {
	tm := newMockTMDB(t)
	env := testutil.New(t, func(c *config.Config) {
		c.TMDB.BaseURL = tm.URL
		c.TMDB.AccessToken = "tmdb-token"
	})
	good := &sources.FakeOnline{Fake: sources.Fake{
		Desc: sources.Info{ID: "anilibria", Kind: sources.KindAnime, Title: "AniLiberty", Configured: true},
		Items: []sources.Variant{
			{Voice: "AniLiberty", MaxQuality: 1080, Qualities: []int{1080, 720, 480}, Format: "hls", Ref: json.RawMessage(`{"release":9}`)},
			{Voice: "LostFilm", MaxQuality: 720, Qualities: []int{720}, Format: "mp4", Ref: json.RawMessage(`{"release":10}`)},
		},
	}}
	bad := &sources.FakeOnline{Fake: sources.Fake{
		Desc: sources.Info{ID: "flaky", Kind: sources.KindOnline, Title: "Flaky", Configured: true},
		Err:  errors.New("upstream 500"),
	}}
	env.Server.Sources.Register(good)
	env.Server.Sources.Register(bad)
	return env, good, bad
}

func media(t *testing.T, env *testutil.Env, kind string, tmdbID int) string {
	var id string
	if err := env.Pool.QueryRow(context.Background(), `INSERT INTO media (kind, tmdb_id) VALUES ($1, $2) RETURNING id`,
		kind, tmdbID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func providerStatus(l map[string]any, id string) map[string]any {
	for _, p := range l["providers"].([]any) {
		if m := p.(map[string]any); m["id"] == id {
			return m
		}
	}
	return nil
}

func TestOnlineSearch(t *testing.T) {
	env, good, bad := setup(t)
	c, _ := env.NewUserClient("alice", "user")
	id := media(t, env, "movie", 603)

	l := c.Do("GET", "/api/v1/media/"+id+"/online", nil).Expect(200).JSON()
	items := l["items"].([]any)
	if len(items) != 2 || l["cached"] != false {
		t.Fatalf("online %v", l)
	}
	if st := providerStatus(l, "anilibria"); st["status"] != "ok" || st["count"].(float64) != 2 || st["kind"] != "anime" {
		t.Fatalf("good status %v", st)
	}
	if st := providerStatus(l, "flaky"); st["status"] != "error" || !strings.Contains(st["error"].(string), "500") {
		t.Fatalf("bad status %v", st)
	}
	top := items[0].(map[string]any)
	if top["preferred"] != true || !strings.HasPrefix(top["id"].(string), "o") || top["provider"].(map[string]any)["name"] != "AniLiberty" {
		t.Fatalf("top %v", top)
	}
	if strings.Contains(fmt.Sprint(l), "release") { // refs never leak
		t.Fatalf("ref leaked: %v", l)
	}
	vo := top["voiceover"].(map[string]any)
	if vo["language"] != "ru" {
		t.Fatalf("voiceover %v", vo)
	}

	// Cached: providers are not asked again; errors are cached briefly too.
	g, b := good.Calls.Load(), bad.Calls.Load()
	l2 := c.Do("GET", "/api/v1/media/"+id+"/online", nil).Expect(200).JSON()
	if l2["cached"] != true || good.Calls.Load() != g || bad.Calls.Load() != b {
		t.Fatalf("cache miss: %v", l2["cached"])
	}
	c.Do("GET", "/api/v1/media/"+id+"/online?refresh=true", nil).Expect(200)
	if good.Calls.Load() != g+1 {
		t.Fatalf("refresh not live")
	}

	// Playback can resolve a shown variant with its ref.
	var lostfilm string
	for _, it := range items {
		if m := it.(map[string]any); m["voice"] == "LostFilm" {
			lostfilm = m["id"].(string)
		}
	}
	v, err := env.Server.Online.LookupVariant(context.Background(), id, lostfilm)
	if err != nil || string(v.Ref) != `{"release": 10}` && string(v.Ref) != `{"release":10}` || v.Provider != "anilibria" {
		t.Fatalf("lookup %+v %v", v, err)
	}
	if _, err := env.Server.Online.LookupVariant(context.Background(), id, "onope"); !errors.Is(err, sources.ErrNotFound) {
		t.Fatalf("unknown variant %v", err)
	}

	// The profile's preferred voice-over wins the auto-pick.
	prof := c.Do("POST", "/api/v1/profiles", map[string]string{"name": "Kid"}).Expect(201).JSON()
	pid := prof["id"].(string)
	c.Do("PUT", "/api/v1/profiles/"+pid+"/preferences", map[string]any{"ui_language": "ru", "preferred_audio_languages": []string{"ru"},
		"preferred_subtitle_languages": []string{}, "preferred_resolution": "1080p", "preferred_codecs": []string{},
		"preferred_voiceovers": []string{"LostFilm"}}).Expect(200)
	l3 := c.Do("GET", "/api/v1/media/"+id+"/online?profile_id="+pid, nil).Expect(200).JSON()
	if top := l3["items"].([]any)[0].(map[string]any); top["voice"] != "LostFilm" || top["preferred"] != true {
		t.Fatalf("preferred voice ignored: %v", top)
	}

	// The profile excludes the anime provider → only flaky is asked.
	c.Do("PUT", "/api/v1/profiles/"+pid+"/settings", map[string]any{"sources": map[string]any{"enabled": []string{"flaky", "prowlarr"}}}).Expect(200)
	l4 := c.Do("GET", "/api/v1/media/"+id+"/online?profile_id="+pid, nil).Expect(200).JSON()
	if len(l4["items"].([]any)) != 0 || providerStatus(l4, "anilibria") != nil || providerStatus(l4, "flaky") == nil {
		t.Fatalf("selection ignored: %v", l4)
	}

	// Validation.
	c.Do("GET", "/api/v1/media/"+id+"/online?season=1", nil).Expect(422)
	c.Do("GET", "/api/v1/media/"+id+"/online?episode=1", nil).Expect(422)
	bob, _ := env.NewUserClient("bob", "user")
	bob.Do("GET", "/api/v1/media/"+id+"/online?profile_id="+pid, nil).Expect(404)
}

func TestOnlineTimeoutAndSeries(t *testing.T) {
	env, good, _ := setup(t)
	env.Server.Online.SetProviderTimeout(200 * time.Millisecond)
	slow := &sources.FakeOnline{Fake: sources.Fake{
		Desc:  sources.Info{ID: "slow", Kind: sources.KindOnline, Title: "Slow", Configured: true},
		Delay: 5 * time.Second, Items: []sources.Variant{{Voice: "x", Format: "hls"}},
	}}
	env.Server.Sources.Register(slow)
	good.Items = []sources.Variant{
		{Voice: "AniLiberty", Season: 1, Episodes: []int{1, 2, 3}, Format: "hls", MaxQuality: 1080, Ref: json.RawMessage(`{"s":1}`)},
		{Voice: "AniLiberty", Season: 2, Episodes: []int{1}, Format: "hls", MaxQuality: 1080, Ref: json.RawMessage(`{"s":2}`)},
	}
	c, _ := env.NewUserClient("alice", "user")
	id := media(t, env, "series", 1399)
	start := time.Now()
	l := c.Do("GET", "/api/v1/media/"+id+"/online?season=1", nil).Expect(200).JSON()
	if time.Since(start) > 3*time.Second {
		t.Fatal("slow provider blocked the response")
	}
	if st := providerStatus(l, "slow"); st["status"] != "timeout" {
		t.Fatalf("slow %v", st)
	}
	items := l["items"].([]any)
	if len(items) != 1 || fmt.Sprint(items[0].(map[string]any)["episodes"]) != "[1 2 3]" || items[0].(map[string]any)["season"].(float64) != 1 {
		t.Fatalf("series items %v", items)
	}
}

func TestSourcesCatalogSettingsAndAdmin(t *testing.T) {
	env, _, _ := setup(t)
	c, user := env.NewUserClient("alice", "user")
	admin, _ := env.NewUserClient("root", "admin")

	l := c.Do("GET", "/api/v1/sources", nil).Expect(200).JSON()
	if l["enabled"] != "all" {
		t.Fatalf("default selection %v", l["enabled"])
	}
	ids := map[string]map[string]any{}
	for _, it := range l["items"].([]any) {
		m := it.(map[string]any)
		ids[m["id"].(string)] = m
	}
	if p := ids["prowlarr"]; p == nil || p["kind"] != "torrent" || p["configured"] != false || p["available"] != false ||
		p["enabled"] != true || p["needs_credentials"] != true || p["name"] != "Prowlarr" {
		t.Fatalf("prowlarr %v", ids["prowlarr"])
	}
	if a := ids["anilibria"]; a == nil || a["enabled_by_admin"] != true || a["available"] != true || a["healthy"] != nil {
		t.Fatalf("anilibria %v", a)
	}

	// Profile settings: default "all", lists validated against the registry.
	prof := c.Do("POST", "/api/v1/profiles", map[string]string{"name": "P"}).Expect(201).JSON()
	pid := prof["id"].(string)
	st := c.Do("GET", "/api/v1/profiles/"+pid+"/settings", nil).Expect(200).JSON()
	if fmt.Sprint(st["sources"]) != "map[enabled:all]" {
		t.Fatalf("default sources %v", st["sources"])
	}
	for _, bad := range []any{
		map[string]any{"enabled": []string{"nope"}},
		map[string]any{"enabled": "some"},
		map[string]any{"enabled": 5},
		"all",
		map[string]any{"enabled": []string{"BAD ID"}},
	} {
		if r := c.Do("PUT", "/api/v1/profiles/"+pid+"/settings", map[string]any{"sources": bad}); r.Status != 422 {
			t.Fatalf("%v → %d %s", bad, r.Status, r.Body)
		}
	}
	c.Do("PUT", "/api/v1/profiles/"+pid+"/settings", map[string]any{"sources": map[string]any{"enabled": []string{"anilibria"}}}).Expect(200)
	// Other settings keep the choice.
	c.Do("PUT", "/api/v1/profiles/"+pid+"/settings", map[string]any{"theme": "dark"}).Expect(200)
	l2 := c.Do("GET", "/api/v1/sources?profile_id="+pid, nil).Expect(200).JSON()
	if fmt.Sprint(l2["enabled"]) != "[anilibria]" {
		t.Fatalf("profile selection %v", l2["enabled"])
	}
	for _, it := range l2["items"].([]any) {
		m := it.(map[string]any)
		if (m["id"] == "anilibria") != (m["enabled"] == true) {
			t.Fatalf("enabled flag %v", m)
		}
	}
	c.Do("PUT", "/api/v1/profiles/"+pid+"/settings", map[string]any{"sources": map[string]any{"enabled": "all"}}).Expect(200)

	// Admin only.
	c.Do("GET", "/api/v1/admin/sources", nil).Expect(403)
	c.Do("PATCH", "/api/v1/admin/sources/anilibria", map[string]any{"enabled": false}).Expect(403)
	admin.Do("PATCH", "/api/v1/admin/sources/nope", map[string]any{"enabled": false}).Expect(404)
	admin.Do("PATCH", "/api/v1/admin/sources/anilibria", map[string]any{"base_url": "ftp://x"}).Expect(422)
	admin.Do("PATCH", "/api/v1/admin/sources/anilibria", map[string]any{}).Expect(422)

	v := admin.Do("PATCH", "/api/v1/admin/sources/anilibria", map[string]any{"enabled": false,
		"credentials": map[string]string{"token": "sup3r-secret"}}).Expect(200)
	if strings.Contains(string(v.Body), "sup3r-secret") {
		t.Fatalf("credentials returned: %s", v.Body)
	}
	if m := v.JSON(); m["enabled_by_admin"] != false || m["has_credentials"] != true {
		t.Fatalf("admin view %v", m)
	}
	var secret []byte
	if err := env.Pool.QueryRow(context.Background(), `SELECT secret FROM source_config WHERE id = 'anilibria'`).Scan(&secret); err != nil ||
		strings.Contains(string(secret), "sup3r") {
		t.Fatalf("secret stored in clear: %v", err)
	}
	var n int
	if err := env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events WHERE action = 'sources.updated'
		AND target_id = 'anilibria' AND metadata::text NOT LIKE '%sup3r%'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("audit %d %v", n, err)
	}
	// Disabled for everyone: shown as unavailable, not searched.
	id := media(t, env, "movie", 603)
	l3 := c.Do("GET", "/api/v1/media/"+id+"/online", nil).Expect(200).JSON()
	if providerStatus(l3, "anilibria") != nil {
		t.Fatalf("disabled provider searched: %v", l3)
	}
	all := admin.Do("GET", "/api/v1/admin/sources", nil).Expect(200).Items()
	if len(all) < 3 {
		t.Fatalf("admin list %v", all)
	}
	// Probe: the fake is healthy.
	pr := admin.Do("POST", "/api/v1/admin/sources/flaky/probe", nil).Expect(200).JSON()
	if pr["healthy"] != true || pr["checked_at"] == nil {
		t.Fatalf("probe %v", pr)
	}
	// Credentials can be cleared; base_url accepted.
	m := admin.Do("PATCH", "/api/v1/admin/sources/anilibria", map[string]any{"enabled": true, "credentials": map[string]string{},
		"base_url": "https://api.anilibria.app/"}).Expect(200).JSON()
	if m["has_credentials"] != false || m["base_url"] != "https://api.anilibria.app" || m["enabled_by_admin"] != true {
		t.Fatalf("cleared %v", m)
	}
	_ = user
}

func TestSourcesTVAccess(t *testing.T) {
	env, _, _ := setup(t)
	c, _ := env.NewUserClient("alice", "user")
	prof := c.Do("POST", "/api/v1/profiles", map[string]string{"name": "TV"}).Expect(201).JSON()
	pid := prof["id"].(string)
	_, cred := env.Pair(c, "Living room")
	tv := env.Client()
	tv.Bearer = cred
	id := media(t, env, "movie", 603)
	tv.Do("GET", "/api/v1/sources?profile_id="+pid, nil).Expect(200)
	if l := tv.Do("GET", "/api/v1/media/"+id+"/online?profile_id="+pid, nil).Expect(200).JSON(); len(l["items"].([]any)) != 2 {
		t.Fatalf("tv online %v", l)
	}
	tv.Do("GET", "/api/v1/admin/sources", nil).Expect(403)
	tv.Do("PUT", "/api/v1/profiles/"+pid+"/settings", map[string]any{"sources": map[string]any{"enabled": []string{"anilibria"}}}).Expect(200)
	env.Client().Do("GET", "/api/v1/sources", nil).Expect(401)
}

func TestRegistryFiltering(t *testing.T) {
	env, _, _ := setup(t)
	reg := env.Server.Sources
	ctx := context.Background()
	torrent := &sources.FakeTorrent{Fake: sources.Fake{Desc: sources.Info{ID: "t1", Kind: sources.KindTorrent, Title: "T1", Configured: true}}}
	unconf := &sources.FakeTorrent{Fake: sources.Fake{Desc: sources.Info{ID: "t2", Kind: sources.KindTorrent, Title: "T2"}}}
	reg.Register(torrent)
	reg.Register(unconf)
	ids := func(ps []sources.TorrentProvider) string {
		var out []string
		for _, p := range ps {
			out = append(out, p.Info().ID)
		}
		return strings.Join(out, ",")
	}
	if got := ids(reg.TorrentProviders(ctx, sources.AllSources)); got != "t1" { // prowlarr/t2 unconfigured
		t.Fatalf("all %q", got)
	}
	if got := ids(reg.TorrentProviders(ctx, sources.Selection{IDs: []string{"t2", "anilibria"}})); got != "" {
		t.Fatalf("subset %q", got)
	}
	if n := len(reg.OnlineProviders(ctx, sources.Selection{IDs: []string{"anilibria", "t1"}})); n != 1 {
		t.Fatalf("online subset %d", n)
	}
	off := false
	if err := reg.Update(ctx, "t1", sources.Patch{Enabled: &off}, ""); err != nil {
		t.Fatal(err)
	}
	if reg.HasTorrent(ctx) {
		t.Fatal("admin disable ignored")
	}
	if _, err := reg.Online(ctx, "t1"); !errors.Is(err, sources.ErrNotFound) {
		t.Fatalf("online t1 %v", err)
	}
	// Five live failures mark a provider unhealthy; a success heals it.
	for range 5 {
		reg.Report("flaky", errors.New("x"))
	}
	for _, in := range reg.List(ctx) {
		if in.ID == "flaky" && (in.Healthy == nil || *in.Healthy) {
			t.Fatalf("flaky %+v", in)
		}
	}
	reg.Report("flaky", nil)
	for _, in := range reg.List(ctx) {
		if in.ID == "flaky" && !*in.Healthy {
			t.Fatalf("flaky not healed")
		}
	}
}

// TestBalancerProvidersSettings: the real CDNVideoHub and Collaps providers
// (against local fakes) appear in «Источники» enabled by default, follow
// the profile's toggles and the admin base_url override.
func TestBalancerProvidersSettings(t *testing.T) {
	env, _, _ := setup(t)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/sv/playlist" && r.URL.Query().Get("id") == "301":
			_, _ = w.Write([]byte(`{"titleName":"Матрица (1999)","isSerial":false,"items":[{"vkId":"42","voiceType":"Дубляж"}],"ads":{"vast":{}}}`))
		case r.URL.Path == "/sv/video/42":
			_, _ = w.Write([]byte(`{"duration":8178,"sources":{"mpegHighUrl":"https://cdn.example/?type=3&expires=4102444800000","mpegMediumUrl":"https://cdn.example/?type=2&expires=4102444800000"}}`))
		case r.URL.Path == "/embed/kp/301":
			_, _ = w.Write([]byte("<script>makePlayer({\n blocked: false ,\n title: \"Матрица\",\n source: {\n hls: \"https://cdn.example/m.m3u8?t=4102444800\",\n" +
				" audio: {\"names\":[\"Рус. Дублированный\",\"НТВ\",\"Eng.Original\"],\"order\":[0,1,2]},\n cc: []\n },\n qualityByWidth: {\"1280\":720}\n});</script>"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(api.Close)
	// Admin config (base_url, "" = the public default) is pushed into
	// providers, so point both at local hosts first: never the internet.
	reg := env.Server.Sources
	reg.Register(cdnvideohub.New("", api.Client()))
	reg.Register(collaps.New("", api.Client()))
	c, _ := env.NewUserClient("alice", "user")
	admin, _ := env.NewUserClient("root", "admin")
	admin.Do("PATCH", "/api/v1/admin/sources/cdnvideohub", map[string]any{"base_url": api.URL + "/sv"}).Expect(200)
	admin.Do("PATCH", "/api/v1/admin/sources/collaps", map[string]any{"base_url": "http://127.0.0.1:1"}).Expect(200) // dead host
	pid := c.Do("POST", "/api/v1/profiles", map[string]string{"name": "Alice"}).Expect(201).JSON()["id"].(string)
	id := media(t, env, "movie", 603)
	if _, err := env.Pool.Exec(context.Background(), `UPDATE media SET kp_id = 301 WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}

	// Listed and enabled by default.
	list := c.Do("GET", "/api/v1/sources?profile_id="+pid, nil).Expect(200).JSON()
	seen := map[string]bool{}
	for _, it := range list["items"].([]any) {
		m := it.(map[string]any)
		if m["id"] == "cdnvideohub" || m["id"] == "collaps" {
			if m["kind"] != "online" || m["enabled"] != true || m["available"] != true {
				t.Fatalf("source %v", m)
			}
			seen[m["id"].(string)] = true
		}
	}
	if !seen["cdnvideohub"] || !seen["collaps"] {
		t.Fatalf("sources %v", list)
	}

	// Collaps is on a dead host: error status, CDNVideoHub still answers.
	l := c.Do("GET", "/api/v1/media/"+id+"/online?profile_id="+pid, nil).Expect(200).JSON()
	if st := providerStatus(l, "collaps"); st == nil || st["status"] != "error" {
		t.Fatalf("collaps %v", st)
	}
	if st := providerStatus(l, "cdnvideohub"); st == nil || st["status"] != "ok" || st["count"] != 1.0 {
		t.Fatalf("cdnvideohub %v", st)
	}
	// Admin switches Collaps to a working mirror.
	admin.Do("PATCH", "/api/v1/admin/sources/collaps", map[string]any{"base_url": api.URL + ", http://127.0.0.1:1"}).Expect(200)
	l = c.Do("GET", "/api/v1/media/"+id+"/online?profile_id="+pid+"&refresh=true", nil).Expect(200).JSON()
	voices := map[string]string{}
	for _, it := range l["items"].([]any) {
		m := it.(map[string]any)
		if pid := m["provider"].(map[string]any)["id"].(string); pid != "anilibria" { // the fake from setup
			voices[pid+"/"+m["voice"].(string)] = m["format"].(string)
		}
	}
	if len(voices) != 4 || voices["cdnvideohub/Дубляж"] != "mp4" || voices["collaps/НТВ"] != "hls" || voices["collaps/Оригинал (en)"] != "hls" {
		t.Fatalf("items %v", voices)
	}
	if pr := admin.Do("POST", "/api/v1/admin/sources/collaps/probe", nil).Expect(200).JSON(); pr["healthy"] != true {
		t.Fatalf("probe %v", pr)
	}

	// Profile toggle: CDNVideoHub off → not searched.
	c.Do("PUT", "/api/v1/profiles/"+pid+"/settings", map[string]any{"sources": map[string]any{"enabled": []string{"anilibria", "collaps"}}}).Expect(200)
	l = c.Do("GET", "/api/v1/media/"+id+"/online?profile_id="+pid, nil).Expect(200).JSON()
	if providerStatus(l, "cdnvideohub") != nil || providerStatus(l, "collaps") == nil {
		t.Fatalf("toggle ignored: %v", l["providers"])
	}
}
