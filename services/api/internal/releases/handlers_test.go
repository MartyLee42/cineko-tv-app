package releases_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"martytv/api/internal/catalog"
	"martytv/api/internal/config"
	"martytv/api/internal/integrations/tmdb"
	"martytv/api/internal/releases"
	"martytv/api/internal/testutil"
)

const prowlarrKey = "prowlarr-test-key-7f3a9c"

// ---- mock TMDB: The Matrix (movie 603) and Game of Thrones (tv 1399) ----

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
				"release_date": "1999-03-31", "runtime": 136, "origin_country": []string{"US"}, "external_ids": map[string]any{"imdb_id": "tt0133093"}}
		case "/movie/603/alternative_titles":
			body = map[string]any{"id": 603, "titles": []map[string]any{{"iso_3166_1": "US", "title": "The Matrix 1"}, {"iso_3166_1": "KR", "title": "매트릭스"}}}
		case "/tv/1399":
			name := "Game of Thrones"
			if ru {
				name = "Игра престолов"
			}
			body = map[string]any{"id": 1399, "name": name, "original_name": "Game of Thrones", "original_language": "en",
				"first_air_date": "2011-04-17", "last_air_date": "2019-05-19", "origin_country": []string{"US"},
				"number_of_seasons": 2, "external_ids": map[string]any{"imdb_id": "tt0944947"},
				"seasons": []map[string]any{
					{"season_number": 1, "air_date": "2011-04-17", "episode_count": 10, "name": "Season 1"},
					{"season_number": 2, "air_date": "2012-04-01", "episode_count": 10, "name": "Season 2"},
				}}
		case "/movie/438631":
			title := "Dune"
			if ru {
				title = "Дюна"
			}
			body = map[string]any{"id": 438631, "title": title, "original_title": "Dune", "original_language": "en",
				"release_date": "2021-09-15", "origin_country": []string{"US"}, "external_ids": map[string]any{"imdb_id": "tt1160419"}}
		case "/movie/438631/alternative_titles":
			body = map[string]any{"id": 438631, "titles": []any{}}
		case "/tv/1399/alternative_titles":
			body = map[string]any{"id": 1399, "results": []any{}}
		default:
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// ---- mock Prowlarr ----

type mockProwlarr struct {
	srv      *httptest.Server
	searches atomic.Int32
	fail     atomic.Bool
	mu       sync.Mutex
	queries  []string
	// failedIndexer makes /indexerstatus report a fresh failure for RuTracker.
	failedIndexer atomic.Bool
}

type rel struct {
	title, indexer string
	indexerID      int
	seeders        int
	size           int64
	hash           string
}

var matrixResults = []rel{
	{"Матрица / The Matrix (1999) BDRip 1080p | D, P, A", "RuTor", 2, 50, 10 << 30, "0123456789abcdef0123456789abcdef01234567"},
	{"Матрица / The Matrix [1999, США, фантастика, UHD BDRemux 2160p, HDR10] Dub + Original Eng", "RuTracker.org", 6, 20, 60 << 30, ""},
	{"Матрица / The Matrix (1999) BDRip 720p", "BigFANGroup", 3, 5, 4 << 30, ""},
	{"Матрица: Перезагрузка / The Matrix Reloaded (2003) BDRip 1080p", "NoNaMe Club", 5, 80, 12 << 30, ""},
	{"OST - Матрица / The Matrix [Soundtrack] (1999) FLAC", "RuTor", 2, 9, 1 << 30, ""},
}

var gotResults = []rel{
	{"Игра престолов / Game of Thrones [S01] (2011) BDRip 1080p | LostFilm", "RuTor", 2, 30, 30 << 30, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
	{"Игра престолов / Game of Thrones [S02] (2012) BDRip 1080p | LostFilm", "RuTor", 2, 30, 30 << 30, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
	{"Game.of.Thrones.S01E03.1080p.BluRay.x264-GRP", "NoNaMe Club", 5, 12, 3 << 30, ""},
	{"Game.of.Thrones.S01E04.1080p.BluRay.x264-GRP", "NoNaMe Club", 5, 12, 3 << 30, ""},
	{"Игра престолов / Game of Thrones [S01-08] (2011-2019) BDRip 1080p", "RuTor", 2, 60, 300 << 30, "cccccccccccccccccccccccccccccccccccccccc"},
}

// Same quality; NewStudio has more seeders, so it wins without a preference.
var duneResults = []rel{
	{"Дюна / Dune (2021) WEB-DL 1080p | MVO (NewStudio)", "RuTor", 2, 90, 8 << 30, "dddddddddddddddddddddddddddddddddddddddd"},
	{"Дюна / Dune (2021) WEB-DL 1080p | MVO (LostFilm)", "RuTor", 2, 40, 8 << 30, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},
}

// Returned for the user's own «Уточнить» query "Neo": a differently titled
// upload of the film, a wrong-year copy, a sequel and a soundtrack.
var neoResults = []rel{
	{"Neo - The Chosen One (1999) WEB-DL 1080p", "RuTor", 2, 15, 7 << 30, "1111111111111111111111111111111111111111"},
	{"Матрица / The Matrix (2005) DVDRip", "RuTor", 2, 3, 2 << 30, "2222222222222222222222222222222222222222"},
	{"Матрица: Перезагрузка / The Matrix Reloaded (2003) BDRip 1080p", "RuTor", 2, 80, 12 << 30, "3333333333333333333333333333333333333333"},
	{"OST - Матрица / The Matrix [Soundtrack] (1999) FLAC", "RuTor", 2, 9, 1 << 30, "4444444444444444444444444444444444444444"},
}

func newMockProwlarr(t *testing.T) *mockProwlarr {
	m := &mockProwlarr{}
	started := time.Now().UTC()
	m.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-Key") != prowlarrKey {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/v1/indexer":
			_, _ = w.Write([]byte(`[{"id":2,"name":"RuTor","enable":true,"protocol":"torrent"},{"id":3,"name":"BigFANGroup","enable":true,"protocol":"torrent"},
				{"id":5,"name":"NoNaMe Club","enable":true,"protocol":"torrent"},{"id":6,"name":"RuTracker.org","enable":true,"protocol":"torrent"}]`))
		case "/api/v1/indexerstatus":
			if m.failedIndexer.Load() {
				fmt.Fprintf(w, `[{"id":1,"indexerId":6,"mostRecentFailure":%q}]`, time.Now().UTC().Format(time.RFC3339))
				return
			}
			fmt.Fprintf(w, `[{"id":1,"indexerId":4,"mostRecentFailure":%q}]`, started.Add(-time.Hour).Format(time.RFC3339))
		case "/api/v1/search":
			m.searches.Add(1)
			q := r.URL.Query().Get("query")
			m.mu.Lock()
			m.queries = append(m.queries, q)
			m.mu.Unlock()
			if m.fail.Load() {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			var list []rel
			switch {
			case strings.Contains(q, "Neo"):
				list = neoResults
			case strings.Contains(q, "Matrix") || strings.Contains(q, "Матрица"):
				list = matrixResults
			case strings.Contains(q, "Thrones") || strings.Contains(q, "престолов"):
				list = gotResults
			case strings.Contains(q, "Dune") || strings.Contains(q, "Дюна"):
				list = duneResults
			}
			var out []map[string]any
			for i, x := range list {
				item := map[string]any{"guid": fmt.Sprintf("https://tracker/%d/%s", i, x.indexer), "title": x.title, "size": x.size,
					"seeders": x.seeders, "leechers": 1, "indexer": x.indexer, "indexerId": x.indexerID, "protocol": "torrent",
					"downloadUrl": fmt.Sprintf("%s/%d/download?apikey=%s&link=L%d&file=F", m.srv.URL, x.indexerID, prowlarrKey, i),
					"publishDate": "2020-01-01T00:00:00Z", "categories": []map[string]any{{"id": 2000, "name": "Movies"}}}
				if x.hash != "" {
					item["infoHash"] = x.hash
				}
				out = append(out, item)
			}
			_ = json.NewEncoder(w).Encode(out)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(m.srv.Close)
	return m
}

func configure(tmdbURL string, p *mockProwlarr) testutil.Options {
	return func(c *config.Config) {
		c.TMDB.BaseURL = tmdbURL
		c.TMDB.AccessToken = "tmdb-token"
		if p != nil {
			c.Prowlarr = config.ProwlarrConfig{URL: p.srv.URL, APIKey: prowlarrKey}
		}
	}
}

func insertMedia(t *testing.T, env *testutil.Env, kind string, tmdbID int) string {
	t.Helper()
	var id string
	if err := env.Pool.QueryRow(context.Background(),
		`INSERT INTO media (kind, tmdb_id) VALUES ($1, $2) RETURNING id`, kind, tmdbID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

type list struct {
	Items         []map[string]any `json:"items"`
	SearchedAt    string           `json:"searched_at"`
	Cached        bool             `json:"cached"`
	IndexerErrors []map[string]any `json:"indexer_errors"`
}

func decode(t *testing.T, r *testutil.Response) list {
	t.Helper()
	var l list
	if err := json.Unmarshal(r.Body, &l); err != nil {
		t.Fatalf("decode %s: %v", r.Body, err)
	}
	return l
}

func titles(l list) []string {
	var out []string
	for _, it := range l.Items {
		out = append(out, it["title"].(string))
	}
	return out
}

var releaseFields = []string{"id", "title", "indexer", "size_bytes", "seeders", "leechers", "published_at", "info_hash", "resolution",
	"video_codec", "hdr", "audio_codecs", "languages", "release_group", "source_quality", "year", "seasons", "episodes",
	"is_season_pack", "confidence", "score", "reasons", "warnings"}

func TestReleasesMovie(t *testing.T) {
	tm, pm := newMockTMDB(t), newMockProwlarr(t)
	env := testutil.New(t, configure(tm.URL, pm))
	c, _ := env.NewUserClient("alice", "user")
	id := insertMedia(t, env, "movie", 603)

	res := c.Do("GET", "/api/v1/media/"+id+"/releases?lang=ru", nil).Expect(200)
	if strings.Contains(string(res.Body), prowlarrKey) || strings.Contains(string(res.Body), "download") ||
		strings.Contains(string(res.Body), pm.srv.URL) {
		t.Fatalf("retrieval data leaked: %s", res.Body)
	}
	l := decode(t, res)
	if l.Cached || l.SearchedAt == "" || l.IndexerErrors == nil {
		t.Fatalf("envelope %+v", l)
	}
	got := titles(l)
	if len(got) != 3 {
		t.Fatalf("items %q", got)
	}
	for _, ti := range got {
		if strings.Contains(ti, "Перезагрузка") || strings.Contains(ti, "OST") {
			t.Fatalf("wrong match returned: %q", ti)
		}
	}
	top := l.Items[0]
	for _, f := range releaseFields {
		if _, ok := top[f]; !ok {
			t.Errorf("field %q missing", f)
		}
	}
	if top["title"] != "Матрица / The Matrix (1999) BDRip 1080p | D, P, A" || top["info_hash"] != matrixResults[0].hash ||
		top["id"] != matrixResults[0].hash || top["resolution"] != "1080p" {
		t.Fatalf("top %+v", top)
	}
	if n := pm.searches.Load(); n < 3 || n > 5 {
		t.Fatalf("searches %d", n)
	}
	pm.mu.Lock()
	qs := strings.Join(pm.queries, "|")
	pm.mu.Unlock()
	if !strings.Contains(qs, "The Matrix 1999") || !strings.Contains(qs, "Матрица 1999") {
		t.Fatalf("queries %s", qs)
	}

	// Cached for 30 minutes.
	before := pm.searches.Load()
	l2 := decode(t, c.Do("GET", "/api/v1/media/"+id+"/releases?lang=ru", nil).Expect(200))
	if l2.Items[0]["id"] != top["id"] {
		t.Fatalf("cached order differs")
	}
	// Without a profile, lang=en prefers English audio: the dub-only rip drops.
	if en := decode(t, c.Do("GET", "/api/v1/media/"+id+"/releases?lang=en", nil).Expect(200)); en.Items[0]["id"] == top["id"] {
		t.Fatalf("language preference ignored")
	}
	if !l2.Cached || pm.searches.Load() != before || len(l2.Items) != 3 {
		t.Fatalf("cache miss: cached=%v searches %d→%d", l2.Cached, before, pm.searches.Load())
	}
	// refresh bypasses it.
	l3 := decode(t, c.Do("GET", "/api/v1/media/"+id+"/releases?refresh=true", nil).Expect(200))
	if l3.Cached || pm.searches.Load() == before {
		t.Fatalf("refresh served from cache")
	}

	// A profile preferring 2160p changes the order; size limit flags it.
	prof := c.Do("POST", "/api/v1/profiles", map[string]string{"name": "Kid"}).Expect(201).JSON()
	pid := prof["id"].(string)
	c.Do("PUT", "/api/v1/profiles/"+pid+"/preferences", map[string]any{"ui_language": "ru", "preferred_audio_languages": []string{"ru"},
		"preferred_subtitle_languages": []string{}, "preferred_resolution": "2160p", "preferred_codecs": []string{}}).Expect(200)
	l4 := decode(t, c.Do("GET", "/api/v1/media/"+id+"/releases?profile_id="+pid, nil).Expect(200))
	if l4.Items[0]["resolution"] != "2160p" {
		t.Fatalf("2160p preference ignored: %q", titles(l4))
	}
	c.Do("PUT", "/api/v1/profiles/"+pid+"/preferences", map[string]any{"ui_language": "ru", "preferred_audio_languages": []string{"ru"},
		"preferred_subtitle_languages": []string{}, "preferred_resolution": "2160p", "max_size_gb": 20, "preferred_codecs": []string{}}).Expect(200)
	l5 := decode(t, c.Do("GET", "/api/v1/media/"+id+"/releases?profile_id="+pid, nil).Expect(200))
	for _, it := range l5.Items {
		if it["resolution"] == "2160p" && !strings.Contains(fmt.Sprint(it["warnings"]), "over_size_limit") {
			t.Fatalf("size limit not flagged: %v", it["warnings"])
		}
	}

	// Another user's profile is not accessible.
	bob, _ := env.NewUserClient("bob", "user")
	bob.Do("GET", "/api/v1/media/"+id+"/releases?profile_id="+pid, nil).Expect(404)

	// A paired TV may use the owner's profile.
	_, cred := env.Pair(c, "Living room")
	tv := env.Client()
	tv.Bearer = cred
	tv.Do("GET", "/api/v1/media/"+id+"/releases?profile_id="+pid, nil).Expect(200)
	bobProf := bob.Do("POST", "/api/v1/profiles", map[string]string{"name": "Bob"}).Expect(201).JSON()
	tv.Do("GET", "/api/v1/media/"+id+"/releases?profile_id="+bobProf["id"].(string), nil).Expect(404)

	// Retrieval data stored server-side without the key.
	var withKey int
	if err := env.Pool.QueryRow(context.Background(),
		`SELECT count(*) FROM release_sources WHERE download_url LIKE '%' || $1 || '%' OR release::text LIKE '%' || $1 || '%'`,
		prowlarrKey).Scan(&withKey); err != nil || withKey != 0 {
		t.Fatalf("api key stored: %d %v", withKey, err)
	}
}

func TestReleasesSeriesEpisode(t *testing.T) {
	tm, pm := newMockTMDB(t), newMockProwlarr(t)
	env := testutil.New(t, configure(tm.URL, pm))
	c, _ := env.NewUserClient("alice", "user")
	id := insertMedia(t, env, "series", 1399)

	l := decode(t, c.Do("GET", "/api/v1/media/"+id+"/releases?season=1&episode=3&lang=ru", nil).Expect(200))
	got := strings.Join(titles(l), "\n")
	for _, want := range []string{"[S01] (2011)", "S01E03", "[S01-08]"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	for _, bad := range []string{"[S02]", "S01E04"} {
		if strings.Contains(got, bad) {
			t.Errorf("wrong release %q in\n%s", bad, got)
		}
	}
	for _, it := range l.Items {
		title := it["title"].(string)
		if pack := it["is_season_pack"].(bool); pack != !strings.Contains(title, "S01E03") {
			t.Errorf("is_season_pack=%v for %q", pack, title)
		}
	}
	pm.mu.Lock()
	qs := strings.Join(pm.queries, "|")
	pm.mu.Unlock()
	if !strings.Contains(qs, "Игра престолов 1 сезон") || !strings.Contains(qs, "Game of Thrones S01") {
		t.Fatalf("season queries missing: %s", qs)
	}
	// Different episode → separate cache entry.
	before := pm.searches.Load()
	c.Do("GET", "/api/v1/media/"+id+"/releases?season=1&episode=4", nil).Expect(200)
	if pm.searches.Load() == before {
		t.Fatalf("episode cache key collision")
	}
}

func TestReleasesValidationAndErrors(t *testing.T) {
	tm, pm := newMockTMDB(t), newMockProwlarr(t)
	env := testutil.New(t, configure(tm.URL, pm))
	c, _ := env.NewUserClient("alice", "user")
	movie := insertMedia(t, env, "movie", 603)
	series := insertMedia(t, env, "series", 1399)

	for _, q := range []string{"season=1", "episode=2", "season=x", "season=-1", "episode=0&season=1", "lang=de", "refresh=maybe", "profile_id=nope"} {
		if r := c.Do("GET", "/api/v1/media/"+movie+"/releases?"+q, nil); r.Status != 422 || r.ErrorCode() != "validation_failed" {
			t.Errorf("%s: %d %s", q, r.Status, r.Body)
		}
	}
	c.Do("GET", "/api/v1/media/"+series+"/releases?season=7", nil).Expect(422)
	c.Do("GET", "/api/v1/media/00000000-0000-4000-8000-000000000000/releases", nil).Expect(404)
	c.Do("GET", "/api/v1/media/not-a-uuid/releases", nil).Expect(404)
	env.Client().Do("GET", "/api/v1/media/"+movie+"/releases", nil).Expect(401)

	// Token scopes: read is enough, write-only is not.
	tok := c.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "w", "scopes": []string{"write"}}).Expect(201).JSON()
	bot := env.Client()
	bot.Bearer = tok["secret"].(string)
	if r := bot.Do("GET", "/api/v1/media/"+movie+"/releases", nil); r.Status != 403 || r.ErrorCode() != "insufficient_scope" {
		t.Fatalf("write-only token: %d %s", r.Status, r.Body)
	}

	// Prowlarr failing with nothing cached → 502; with a cache → stale results.
	pm.fail.Store(true)
	r := c.Do("GET", "/api/v1/media/"+movie+"/releases", nil).Expect(502)
	if r.ErrorCode() != "releases_upstream_error" || strings.Contains(string(r.Body), prowlarrKey) {
		t.Fatalf("got %s", r.Body)
	}
	pm.fail.Store(false)
	c.Do("GET", "/api/v1/media/"+movie+"/releases", nil).Expect(200)
	pm.fail.Store(true)
	l := decode(t, c.Do("GET", "/api/v1/media/"+movie+"/releases?refresh=true", nil).Expect(200))
	if !l.Cached || len(l.Items) == 0 || !strings.Contains(fmt.Sprint(l.IndexerErrors), "Prowlarr") {
		t.Fatalf("stale fallback %+v", l)
	}
	pm.fail.Store(false)

	// A fresh per-indexer failure is reported; an old one is not.
	pm.failedIndexer.Store(true)
	l = decode(t, c.Do("GET", "/api/v1/media/"+movie+"/releases?refresh=1", nil).Expect(200))
	if len(l.IndexerErrors) != 1 || l.IndexerErrors[0]["indexer"] != "RuTracker.org" {
		t.Fatalf("indexer errors %+v", l.IndexerErrors)
	}

	// Refreshes are rate limited per user.
	limited := false
	for i := 0; i < 8 && !limited; i++ {
		limited = c.Do("GET", "/api/v1/media/"+movie+"/releases?refresh=true", nil).Status == 429
	}
	if !limited {
		t.Fatalf("refresh not rate limited")
	}
}

func TestReleasesUnconfigured(t *testing.T) {
	tm := newMockTMDB(t)
	env := testutil.New(t, configure(tm.URL, nil))
	c, _ := env.NewUserClient("alice", "user")
	id := insertMedia(t, env, "movie", 603)
	if r := c.Do("GET", "/api/v1/media/"+id+"/releases", nil); r.Status != 503 || r.ErrorCode() != "releases_unavailable" {
		t.Fatalf("got %d %s", r.Status, r.Body)
	}
}

// TestResolve covers the playback contract: a shown release resolves to its
// Prowlarr link (with the key restored) for 24 h, past the 30-min list TTL.
func TestResolve(t *testing.T) {
	tm, pm := newMockTMDB(t), newMockProwlarr(t)
	env := testutil.New(t, configure(tm.URL, pm))
	id := insertMedia(t, env, "movie", 603)

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cat := catalog.NewService(env.Pool, tmdb.New(env.Config.TMDB), env.Config.TMDB, env.Config.Catalog, log)
	svc := releases.NewService(env.Pool, env.Config, cat, log)
	now := time.Now()
	svc.SetNow(func() time.Time { return now })
	var _ releases.Resolver = svc

	l, err := svc.List(context.Background(), releases.ListParams{MediaID: id, Prefs: releases.Prefs{Languages: []string{"ru"}}})
	if err != nil || len(l.Items) == 0 {
		t.Fatalf("list %v %v", l, err)
	}
	ctx := context.Background()
	for _, it := range l.Items {
		res, err := svc.Resolve(ctx, id, it.ID)
		if err != nil {
			t.Fatalf("resolve %s: %v", it.ID, err)
		}
		if res.MediaID != id || res.Release.ID != it.ID || res.Release.Title != it.Title {
			t.Fatalf("resolved %+v", res)
		}
		if !strings.HasPrefix(res.DownloadURL, pm.srv.URL+"/") || !strings.Contains(res.DownloadURL, "apikey="+prowlarrKey) {
			t.Fatalf("download url %q", res.DownloadURL)
		}
	}

	// After the list cache expires the ids still resolve…
	now = now.Add(2 * time.Hour)
	if _, err := svc.Resolve(ctx, id, l.Items[0].ID); err != nil {
		t.Fatalf("after list expiry: %v", err)
	}
	// …but not after a day, nor for another media or an unknown id.
	if _, err := svc.Resolve(ctx, "00000000-0000-4000-8000-000000000000", l.Items[0].ID); !errors.Is(err, releases.ErrReleaseNotFound) {
		t.Fatalf("other media: %v", err)
	}
	if _, err := svc.Resolve(ctx, id, "nope"); !errors.Is(err, releases.ErrReleaseNotFound) {
		t.Fatalf("unknown: %v", err)
	}
	if _, err := svc.Resolve(ctx, "bad", l.Items[0].ID); !errors.Is(err, releases.ErrReleaseNotFound) {
		t.Fatalf("bad media id: %v", err)
	}
	now = now.Add(23 * time.Hour)
	if _, err := svc.Resolve(ctx, id, l.Items[0].ID); !errors.Is(err, releases.ErrReleaseNotFound) {
		t.Fatalf("after 24h: %v", err)
	}
}

func TestReleasesPreferredVoiceover(t *testing.T) {
	tm, pm := newMockTMDB(t), newMockProwlarr(t)
	env := testutil.New(t, configure(tm.URL, pm))
	c, _ := env.NewUserClient("alice", "user")
	id := insertMedia(t, env, "movie", 438631)

	base := decode(t, c.Do("GET", "/api/v1/media/"+id+"/releases?lang=ru", nil).Expect(200))
	if len(base.Items) != 2 || !strings.Contains(base.Items[0]["title"].(string), "NewStudio") {
		t.Fatalf("baseline order %q", titles(base))
	}

	prof := c.Do("POST", "/api/v1/profiles", map[string]string{"name": "Fan"}).Expect(201).JSON()
	pid := prof["id"].(string)
	prefs := map[string]any{"ui_language": "ru", "preferred_audio_languages": []string{"ru"},
		"preferred_subtitle_languages": []string{}, "preferred_resolution": "", "preferred_codecs": []string{},
		"preferred_voiceovers": []string{"LostFilm"}}
	got := c.Do("PUT", "/api/v1/profiles/"+pid+"/preferences", prefs).Expect(200).JSON()
	if fmt.Sprint(got["preferred_voiceovers"]) != "[LostFilm]" {
		t.Fatalf("prefs %v", got)
	}
	l := decode(t, c.Do("GET", "/api/v1/media/"+id+"/releases?profile_id="+pid, nil).Expect(200))
	if !strings.Contains(l.Items[0]["title"].(string), "LostFilm") {
		t.Fatalf("voice-over preference ignored: %q", titles(l))
	}

	// Validation.
	prefs["preferred_voiceovers"] = []string{strings.Repeat("x", 41)}
	if r := c.Do("PUT", "/api/v1/profiles/"+pid+"/preferences", prefs).Expect(422); !strings.Contains(string(r.Body), "preferred_voiceovers") {
		t.Fatalf("422 body %s", r.Body)
	}
	prefs["preferred_voiceovers"] = []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"}
	c.Do("PUT", "/api/v1/profiles/"+pid+"/preferences", prefs).Expect(422)
	// Defaults to [] for a fresh profile.
	other := c.Do("POST", "/api/v1/profiles", map[string]string{"name": "Other"}).Expect(201).JSON()
	if p := c.Do("GET", "/api/v1/profiles/"+other["id"].(string)+"/preferences", nil).Expect(200).JSON(); fmt.Sprint(p["preferred_voiceovers"]) != "[]" {
		t.Fatalf("default voiceovers %v", p["preferred_voiceovers"])
	}
}

// «Уточнить»: the user's own query plus loose matching brings back uncertain
// matches (flagged), never hard rejects (sequels, soundtracks).
func TestReleasesRefineQuery(t *testing.T) {
	tm, pm := newMockTMDB(t), newMockProwlarr(t)
	env := testutil.New(t, configure(tm.URL, pm))
	c, _ := env.NewUserClient("alice", "user")
	id := insertMedia(t, env, "movie", 603)
	base := "/api/v1/media/" + id + "/releases?lang=ru"

	strict := decode(t, c.Do("GET", base+"&q=Neo", nil).Expect(200))
	if len(strict.Items) != 0 {
		t.Fatalf("strict custom query should still reject uncertain matches: %q", titles(strict))
	}
	pm.mu.Lock()
	last := pm.queries[len(pm.queries)-1]
	pm.mu.Unlock()
	if last != "Neo" {
		t.Fatalf("custom query not used: %q", last)
	}

	loose := decode(t, c.Do("GET", base+"&q=Neo&loose=true", nil).Expect(200))
	got := titles(loose)
	if len(got) != 2 {
		t.Fatalf("loose items %q", got)
	}
	for _, it := range loose.Items {
		ti := it["title"].(string)
		if strings.Contains(ti, "Перезагрузка") || strings.Contains(ti, "OST") {
			t.Fatalf("hard reject returned: %q", ti)
		}
		if w := fmt.Sprint(it["warnings"]); !strings.Contains(w, "uncertain_match") {
			t.Fatalf("uncertain match not flagged: %q %v", ti, w)
		}
		if conf := it["confidence"].(float64); conf >= 0.5 {
			t.Fatalf("uncertain match confidence %v", conf)
		}
	}
	// Results are resolvable for playback like any other release.
	if _, err := releasesSvc(env).Resolve(context.Background(), id, loose.Items[0]["id"].(string)); err != nil {
		t.Fatalf("resolve: %v", err)
	}

	c.Do("GET", base+"&q=x", nil).Expect(422)
	c.Do("GET", base+"&loose=maybe", nil).Expect(422)
}

func releasesSvc(env *testutil.Env) *releases.Service {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cat := catalog.NewService(env.Pool, tmdb.New(env.Config.TMDB), env.Config.TMDB, env.Config.Catalog, log)
	return releases.NewService(env.Pool, env.Config, cat, log)
}

// Device playback profiles re-rank per request (cache untouched): the TV's
// own profile applies automatically; users pick device_id or client_id;
// device_prefs=off ignores them.
func TestReleasesDevicePrefs(t *testing.T) {
	tm, pm := newMockTMDB(t), newMockProwlarr(t)
	env := testutil.New(t, configure(tm.URL, pm))
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	id := insertMedia(t, env, "movie", 603)
	devID, cred := env.Pair(alice, "Kitchen")
	tv := env.Client()
	tv.Bearer = cred
	base := "/api/v1/media/" + id + "/releases?lang=ru"

	plain := decode(t, alice.Do("GET", base, nil).Expect(200))
	if plain.Items[0]["resolution"] != "1080p" || plain.Items[0]["est_bitrate_bps"] == nil {
		t.Fatalf("baseline %v %v", titles(plain), plain.Items[0]["est_bitrate_bps"])
	}
	var raw map[string]any
	_ = json.Unmarshal(alice.Do("GET", base, nil).Expect(200).Body, &raw)
	if v, ok := raw["device"]; !ok || v != nil {
		t.Fatalf("device should be null without a profile: %v", raw["device"])
	}
	// A TV that never reported anything ranks like no device.
	if v := tv.Do("GET", base, nil).Expect(200).JSON()["device"]; v != nil {
		t.Fatalf("empty profile applied: %v", v)
	}

	tv.Do("PATCH", "/api/v1/devices/me/playback-prefs", map[string]any{"auto": map[string]any{
		"screen_width": 1280, "screen_height": 720, "video": []string{"h264"}, "audio": []string{"aac", "ac3"}}}).Expect(200)
	searches := pm.searches.Load()
	check := func(c *testutil.Client, q string) map[string]any {
		t.Helper()
		res := c.Do("GET", base+q, nil).Expect(200)
		l := decode(t, res)
		if l.Items[0]["resolution"] != "720p" {
			t.Fatalf("%s: device profile ignored: %v", q, titles(l))
		}
		for _, it := range l.Items {
			if it["resolution"] != "720p" && !strings.Contains(fmt.Sprint(it["warnings"]), "over_device_resolution") {
				t.Fatalf("missing warning: %v", it["warnings"])
			}
		}
		return res.JSON()["device"].(map[string]any)
	}
	if d := check(tv, ""); d["kind"] != "device" || d["id"] != devID || d["name"] != "Kitchen" || len(d["constraints"].([]any)) == 0 {
		t.Fatalf("device %v", d)
	}
	check(alice, "&device_id="+devID)
	if pm.searches.Load() != searches {
		t.Fatalf("device prefs bypassed the cache")
	}
	// «Показать все».
	off := alice.Do("GET", base+"&device_id="+devID+"&device_prefs=off", nil).Expect(200)
	if decode(t, off).Items[0]["resolution"] != "1080p" || off.JSON()["device"] != nil {
		t.Fatalf("device_prefs=off: %s", off.Body)
	}
	if decode(t, tv.Do("GET", base+"&device_prefs=off", nil).Expect(200)).Items[0]["resolution"] != "1080p" {
		t.Fatalf("tv device_prefs=off")
	}
	bob.Do("GET", base+"&device_id="+devID, nil).Expect(404)
	alice.Do("GET", base+"&device_id=nope", nil).Expect(422)
	alice.Do("GET", base+"&device_prefs=maybe", nil).Expect(422)
	alice.Do("GET", base+"&client_id=a", nil).Expect(422)

	// A browser record (the caller's own; unknown → none).
	if v := alice.Do("GET", base+"&client_id=browser-0001", nil).Expect(200).JSON()["device"]; v != nil {
		t.Fatalf("unknown client applied: %v", v)
	}
	alice.Do("PATCH", "/api/v1/me/playback-clients/browser-0001", map[string]any{"name": "Phone",
		"manual": map[string]any{"max_resolution": "720p"}}).Expect(200)
	if d := check(alice, "&client_id=browser-0001"); d["kind"] != "client" || d["id"] != "browser-0001" || d["name"] != "Phone" {
		t.Fatalf("client %v", d)
	}
	if v := bob.Do("GET", base+"&client_id=browser-0001", nil).Expect(200).JSON()["device"]; v != nil {
		t.Fatalf("another user's client applied: %v", v)
	}
}

// A TV (device credential, no device_id / client_id in the query) gets its
// own device-fit ranking; before any throughput is measured a TV-class
// platform is capped at the «normal» preset's 15 Mbit/s instead of no limit.
func TestReleasesTVDefaultsToOwnDeviceUnmeasuredCap(t *testing.T) {
	tm, pm := newMockTMDB(t), newMockProwlarr(t)
	env := testutil.New(t, configure(tm.URL, pm))
	alice, _ := env.NewUserClient("alice", "user")
	id := insertMedia(t, env, "movie", 603)
	devID, cred := env.Pair(alice, "TX3")
	tv := env.Client()
	tv.Bearer = cred
	tv.Do("PATCH", "/api/v1/devices/me/playback-prefs", map[string]any{"auto": map[string]any{
		"screen_width": 1920, "screen_height": 1080, "video": []string{"h264", "hevc"}, "audio": []string{"aac"}, "platform": "android-tv"}}).Expect(200)
	d, _ := tv.Do("GET", "/api/v1/media/"+id+"/releases?lang=ru", nil).Expect(200).JSON()["device"].(map[string]any)
	if d == nil || d["id"] != devID {
		t.Fatalf("TV without device_id: no device fit: %v", d)
	}
	found := false
	for _, c := range d["constraints"].([]any) {
		m := c.(map[string]any)
		if m["code"] == "max_bitrate" && m["mbps"] == float64(15) {
			found = true
		}
	}
	if !found {
		t.Fatalf("unmeasured TV not capped: %v", d["constraints"])
	}
}
