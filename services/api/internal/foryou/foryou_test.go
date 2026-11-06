package foryou

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"martytv/api/internal/catalog"
	"martytv/api/internal/config"
)

var now = time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)

func days(n int) time.Time { return now.Add(-time.Duration(n) * 24 * time.Hour) }

// fixture: a sci-fi lover who dislikes romance.
func scifiFixture() ([]Signal, map[string]Features) {
	feats := map[string]Features{
		"m1": {Kind: "movie", Genres: []int{878, 28}, Year: 1982, Lang: "en", Countries: []string{"US"}, Directors: []int{1}, Actors: []int{10, 11}, HasCredits: true},
		"m2": {Kind: "movie", Genres: []int{878, 53}, Year: 1979, Lang: "en", Countries: []string{"US", "GB"}, Directors: []int{1}, Actors: []int{12}, HasCredits: true},
		"m3": {Kind: "movie", Genres: []int{878, 18}, Year: 2014, Lang: "en", Countries: []string{"US"}, Directors: []int{2}, Actors: []int{10}, HasCredits: true},
		"m4": {Kind: "movie", Genres: []int{28}, Year: 1999, Lang: "en", Directors: []int{3}},
		"m5": {Kind: "movie", Genres: []int{10749, 35}, Year: 2005, Lang: "fr", Countries: []string{"FR"}, Directors: []int{4}},
		"m6": {Kind: "movie", Genres: []int{10749}, Year: 2010, Lang: "en", Directors: []int{4}},
		"m7": {Kind: "series", Genres: []int{10765}, Year: 2016, Lang: "en"},
		"m8": {Kind: "movie", Genres: []int{27}, Year: 2018, Lang: "en"},
	}
	signals := []Signal{
		{MediaID: "m1", Rating: 10, RatedAt: days(10), Completed: true, CompletedAt: days(10), Favorite: true, FavoriteAt: days(10)},
		{MediaID: "m2", Rating: 9, RatedAt: days(400), Completed: true, CompletedAt: days(400)},
		{MediaID: "m3", Rating: 9, RatedAt: days(20)},
		{MediaID: "m4", Completed: true, CompletedAt: days(30)},
		{MediaID: "m5", Rating: 3, RatedAt: days(100)},
		{MediaID: "m6", Dismissed: true, DismissedAt: days(5)},
		{MediaID: "m7", Watchlist: true, WatchlistAt: days(2)},
		// Abandoned horror: started, 5 %, idle for weeks.
		{MediaID: "m8", Started: true, Percent: 0.05, LastActivity: days(40)},
	}
	return signals, feats
}

func affinity(list []Affinity, key string) (Affinity, bool) {
	for _, a := range list {
		if a.Key == key {
			return a, true
		}
	}
	return Affinity{}, false
}

func TestComputeTaste(t *testing.T) {
	signals, feats := scifiFixture()
	w := DefaultWeights()
	tst := ComputeTaste(signals, feats, now, w)

	if tst.Genres[0].Key != "878" || tst.Genres[0].Score != 1 {
		t.Fatalf("top genre %+v", tst.Genres)
	}
	if a, _ := affinity(tst.Genres, "10749"); a.Score >= 0 {
		t.Fatalf("romance should be negative: %+v", a)
	}
	if a, _ := affinity(tst.Genres, "27"); a.Score >= 0 {
		t.Fatalf("abandoned horror should be negative: %+v", a)
	}
	if a, _ := affinity(tst.Languages, "fr"); a.Score >= 0 {
		t.Fatalf("french (from a 3/10) should be negative: %+v", a)
	}
	// Director 1 has two loved titles; directors with one title don't count.
	if len(tst.Directors) != 2 || tst.Directors[0].Key != "1" || tst.Directors[0].Count != 2 {
		t.Fatalf("directors %+v", tst.Directors)
	}
	if a, ok := affinity(tst.Directors, "4"); !ok || a.Score >= 0 {
		t.Fatalf("director 4 (romance) should be disliked: %+v", tst.Directors)
	}
	if a, ok := affinity(tst.Actors, "10"); !ok || a.Count != 2 {
		t.Fatalf("actors %+v", tst.Actors)
	}
	st := tst.Stats
	if st.Ratings != 4 || st.Completed != 3 || st.Favorites != 1 || st.Dismissed != 1 || st.Abandoned != 1 || st.Watchlist != 1 {
		t.Fatalf("stats %+v", st)
	}
	if st.Histogram[9] != 1 || st.Histogram[8] != 2 || st.Histogram[2] != 1 || st.AverageRating != 7.75 {
		t.Fatalf("histogram %+v avg %v", st.Histogram, st.AverageRating)
	}
	// Seeds: liked titles, strongest (and most recent) first.
	if len(tst.Seeds) == 0 || tst.Seeds[0].MediaID != "m1" {
		t.Fatalf("seeds %+v", tst.Seeds)
	}
	for _, s := range tst.Seeds {
		if s.MediaID == "m5" || s.MediaID == "m6" || s.MediaID == "m8" {
			t.Fatalf("disliked title seeded: %+v", tst.Seeds)
		}
	}
	// Recency: the same 9/10 counts more when recent (m3) than old (m2).
	w3, _ := signalWeight(signals[2], tst.RatingCenter, now, w)
	w2, _ := signalWeight(signals[1], tst.RatingCenter, now, w)
	if !(w3 > w2) {
		t.Fatalf("recency: recent %v <= old %v", w3, w2)
	}
	// Deterministic.
	again := ComputeTaste(signals, feats, now, w)
	again.genre, again.decade, again.lang, again.country = nil, nil, nil, nil
	tst.genre, tst.decade, tst.lang, tst.country = nil, nil, nil, nil
	if !reflect.DeepEqual(tst, again) {
		t.Fatal("taste is not deterministic")
	}
}

func TestRatingCenterClamps(t *testing.T) {
	w := DefaultWeights()
	gen := []Signal{{Rating: 10}, {Rating: 10}, {Rating: 9}}
	if c := ratingCenter(gen, w); c != w.RatingCenterMax {
		t.Fatalf("generous rater center %v", c)
	}
	if c := ratingCenter(nil, w); c != 6.5 {
		t.Fatalf("default center %v", c)
	}
}

func cand(id string, genres []int, year int, votes int, avg float64, srcs ...Source) *Candidate {
	return &Candidate{MediaID: id, Features: Features{Kind: "movie", Genres: genres, Year: year, Lang: "en"},
		VoteAverage: avg, VoteCount: votes, Popularity: 20, Sources: srcs}
}

func TestScoreAndReasons(t *testing.T) {
	signals, feats := scifiFixture()
	w := DefaultWeights()
	tst := ComputeTaste(signals, feats, now, w)

	scifi := cand("a", []int{878}, 1984, 5000, 7.9, Source{Type: ReasonBecause, MediaID: "m1", Strength: 0.9})
	romance := cand("b", []int{10749}, 2008, 5000, 7.9, Source{Type: ReasonGenre, GenreIDs: []int{10749}, Strength: 0.25})
	sa, sb := Score(scifi, tst, w), Score(romance, tst, w)
	if !(sa.Score > sb.Score) {
		t.Fatalf("sci-fi %v should beat romance %v", sa.Score, sb.Score)
	}
	if sa.Reason.Type != ReasonBecause || sa.Reason.MediaID != "m1" {
		t.Fatalf("reason %+v", sa.Reason)
	}
	// Director source wins over a weak genre source.
	d := cand("c", []int{878}, 1990, 3000, 7.5,
		Source{Type: ReasonGenre, GenreIDs: []int{878}, Strength: 0.2},
		Source{Type: ReasonDirector, PersonID: 1, Strength: 0.8})
	if r := Score(d, tst, w).Reason; r.Type != ReasonDirector || r.PersonID != 1 {
		t.Fatalf("director reason %+v", r)
	}
	// Genre-only candidates explain with the liked genres they carry.
	g := cand("d", []int{18, 878}, 2001, 3000, 7.5, Source{Type: ReasonGenre, GenreIDs: []int{18}, Strength: 0.2})
	if r := Score(g, tst, w).Reason; r.Type != ReasonGenre || len(r.GenreIDs) == 0 || r.GenreIDs[0] != 878 {
		t.Fatalf("genre reason %+v", r)
	}
	// Quality is shrunk: 9.5 with 5 votes is not better than 8.0 with 20k.
	few := cand("e", []int{878}, 2001, 5, 9.5)
	many := cand("f", []int{878}, 2001, 20000, 8.0)
	if quality(few, w) >= quality(many, w) {
		t.Fatal("bayesian quality")
	}
	// Fatigue: unopened impressions lower the score.
	tired := *scifi
	tired.Impressions, tired.Shown = 5, true
	if Score(&tired, tst, w).Score >= sa.Score {
		t.Fatal("fatigue")
	}
	if !reflect.DeepEqual(Score(scifi, tst, w), Score(scifi, tst, w)) {
		t.Fatal("not deterministic")
	}
}

func buildFixtureRows(t *testing.T, tst *Taste) []cachedRow {
	t.Helper()
	w := DefaultWeights()
	var all []Scored
	for i := 0; i < 70; i++ {
		id := "c" + strconv.Itoa(100+i)
		var c *Candidate
		switch {
		case i < 20:
			c = cand(id, []int{878, 28}, 1980+i, 3000+i*10, 7.0+float64(i%5)/10, Source{Type: ReasonBecause, MediaID: "m1", Strength: 0.9 - float64(i)/40})
		case i < 40:
			c = cand(id, []int{878}, 1950+i, 1000, 7.2, Source{Type: ReasonDirector, PersonID: 1, Strength: 0.8})
		case i < 50:
			c = cand(id, []int{53, 878}, 2000+i%10, 300, 7.9, Source{Type: ReasonHiddenGem, Strength: 0.45})
		case i < 60:
			c = cand(id, []int{18}, 1990+i%10, 8000, 8.2, Source{Type: ReasonDifferent, GenreIDs: []int{18}, Strength: 0.4})
		default:
			c = cand(id, []int{28, 12}, 2026, 900, 6.9, Source{Type: ReasonTrending, Strength: 0.35})
		}
		all = append(all, Score(c, tst, w))
	}
	return BuildRows(all, tst, w, nil, false)
}

func TestBuildRowsUniqueAndTyped(t *testing.T) {
	signals, feats := scifiFixture()
	tst := ComputeTaste(signals, feats, now, DefaultWeights())
	rows := buildFixtureRows(t, tst)
	seen := map[string]string{}
	kinds := map[string]bool{}
	for _, r := range rows {
		kinds[r.Kind] = true
		if len(r.Items) < DefaultWeights().MinRowItems {
			t.Fatalf("row %s too small", r.ID)
		}
		for _, it := range r.Items {
			if prev, dup := seen[it.MediaID]; dup {
				t.Fatalf("%s in %s and %s", it.MediaID, prev, r.ID)
			}
			seen[it.MediaID] = r.ID
		}
	}
	if rows[0].Kind != RowTopPicks {
		t.Fatalf("first row %s", rows[0].Kind)
	}
	for _, k := range []string{RowBecause, RowDirector, RowHiddenGems, RowDifferent} {
		if !kinds[k] {
			t.Fatalf("missing %s row: %+v", k, kinds)
		}
	}
	for _, r := range rows {
		switch r.Kind {
		case RowBecause:
			if r.ID != "byr:m1" || r.Reason.MediaID != "m1" || r.Items[0].Reason.Type != ReasonBecause {
				t.Fatalf("because row %+v", r)
			}
		case RowDirector:
			if r.Reason.PersonID != 1 {
				t.Fatalf("director row %+v", r.Reason)
			}
		case RowDifferent:
			if r.Items[0].Reason.Type != ReasonDifferent || r.Items[0].Reason.GenreIDs[0] != 18 {
				t.Fatalf("different reason %+v", r.Items[0].Reason)
			}
		}
	}
	if !reflect.DeepEqual(rows, buildFixtureRows(t, tst)) {
		t.Fatal("rows not deterministic")
	}
}

func TestMMRDiversifies(t *testing.T) {
	a := &Scored{Candidate: cand("a", []int{878}, 1990, 1, 1), Score: 1}
	b := &Scored{Candidate: cand("b", []int{878}, 1991, 1, 1), Score: 0.99}
	c := &Scored{Candidate: cand("c", []int{35}, 2010, 1, 1), Score: 0.9}
	got := mmr([]*Scored{a, b, c}, []float64{1, 0.99, 0.9}, 2, 0.5)
	if len(got) != 2 || got[0] != 0 || got[1] != 2 {
		t.Fatalf("mmr picked %v", got)
	}
}

func TestSurpriseFilter(t *testing.T) {
	scary := newSurpriseFilter(SurpriseRequest{Mood: "scary", Kind: "movie"})
	horror := mediaFacts{Features: Features{Kind: "movie", Genres: []int{27}, Year: 1980}}
	comedy := mediaFacts{Features: Features{Kind: "movie", Genres: []int{35}, Year: 1980}}
	if !scary.ok(horror) || scary.ok(comedy) {
		t.Fatal("mood genres")
	}
	cozy := newSurpriseFilter(SurpriseRequest{Mood: "cozy", Kind: "movie"})
	if cozy.ok(mediaFacts{Features: Features{Kind: "movie", Genres: []int{35, 27}}}) {
		t.Fatal("mood exclusions")
	}
	d := 1980
	rmin, rmax := 90, 120
	r := 7.0
	f := newSurpriseFilter(SurpriseRequest{Kind: "movie", Decade: &d, RuntimeMin: &rmin, RuntimeMax: &rmax, MinRating: &r})
	ok := mediaFacts{Features: Features{Kind: "movie", Year: 1985}, Runtime: 100, VoteAverage: 7.5, VoteCount: 500}
	if !f.ok(ok) {
		t.Fatal("should pass")
	}
	for name, m := range map[string]mediaFacts{
		"decade":       {Features: Features{Kind: "movie", Year: 1990}, Runtime: 100, VoteAverage: 7.5, VoteCount: 500},
		"runtime":      {Features: Features{Kind: "movie", Year: 1985}, Runtime: 150, VoteAverage: 7.5, VoteCount: 500},
		"no runtime":   {Features: Features{Kind: "movie", Year: 1985}, VoteAverage: 7.5, VoteCount: 500},
		"rating":       {Features: Features{Kind: "movie", Year: 1985}, Runtime: 100, VoteAverage: 6.5, VoteCount: 500},
		"kp low":       {Features: Features{Kind: "movie", Year: 1985}, Runtime: 100, VoteAverage: 8, VoteCount: 500, KPRating: 6.9},
		"kind":         {Features: Features{Kind: "series", Year: 1985}, Runtime: 100, VoteAverage: 7.5, VoteCount: 500},
		"few votes":    {Features: Features{Kind: "movie", Year: 1985}, Runtime: 100, VoteAverage: 9, VoteCount: 3},
		"series genre": {Features: Features{Kind: "series", Genres: []int{10765}, Year: 1985}},
	} {
		if f.ok(m) {
			t.Fatalf("%s should fail", name)
		}
	}
	// Movie genres map to tv genres for series.
	sf := newSurpriseFilter(SurpriseRequest{Genres: []int{878}, Kind: "any"})
	if !sf.ok(mediaFacts{Features: Features{Kind: "series", Genres: []int{10765}}}) {
		t.Fatal("tv genre mapping")
	}
	// Weighted pick favours the best but is a distribution.
	scores := []float64{2, 1, 0}
	if weightedPick(scores, 0) != 0 || weightedPick(scores, 0.9999) == 0 {
		t.Fatal("weighted pick")
	}
}

func TestParseCollections(t *testing.T) {
	items := func(n int) string {
		var parts []string
		for i := 0; i < n; i++ {
			parts = append(parts, `{"title":"T`+strconv.Itoa(i)+`","original_title":"O`+strconv.Itoa(i)+`","year":"`+strconv.Itoa(1990+i)+`","kind":"film"}`)
		}
		return strings.Join(parts, ",")
	}
	ok := `{"collections":[{"title_ru":"Ночь","title_en":"Night","description_ru":"д","description_en":"d","items":[` + items(8) + `]},` +
		`{"title_ru":"Мало","title_en":"Few","items":[` + items(3) + `]}]}`
	cols, err := parseCollections(ok)
	if err != nil || len(cols) != 1 || len(cols[0].Items) != 8 || cols[0].Items[0].Year != 1990 || cols[0].Items[0].Kind != "movie" {
		t.Fatalf("parsed %+v %v", cols, err)
	}
	bare, err := parseCollections("```json\n[{\"title_en\":\"Only EN\",\"items\":[" + items(6) + "]}]```")
	if err != nil || bare[0].TitleRU != "Only EN" {
		t.Fatalf("bare array %+v %v", bare, err)
	}
	for _, bad := range []string{"not json", `{"collections":"x"}`, `{"foo":[]}`, `{"collections":[{"title_ru":"x","items":[]}]}`} {
		if _, err := parseCollections(bad); err != errInvalidAI {
			t.Fatalf("%q: %v", bad, err)
		}
	}
}

func TestMatchResult(t *testing.T) {
	y := func(n int) *int { return &n }
	res := []catalog.MediaSummary{
		{ID: "1", Title: "Blade Runner", OriginalTitle: "Blade Runner", Year: y(1982)},
		{ID: "2", Title: "Blade Runner 2049", OriginalTitle: "Blade Runner 2049", Year: y(2017)},
		{ID: "3", Title: "Twin", OriginalTitle: "Twin", Year: y(2001)},
		{ID: "4", Title: "Twin", OriginalTitle: "Twin", Year: y(2001)},
		{ID: "5", Title: "Parasite", OriginalTitle: "기생충", Year: y(2019)},
	}
	cases := []struct {
		it   aiItem
		want string
	}{
		{aiItem{Title: "Blade Runner", Year: 1982}, "1"},
		{aiItem{Title: "the blade runner!", Year: 1983}, "1"}, // article, punctuation, ±1
		{aiItem{Title: "Blade Runner", Year: 1990}, ""},       // wrong year
		{aiItem{Title: "Twin", Year: 2001}, ""},               // ambiguous
		{aiItem{Title: "Parasite", OriginalTitle: "기생충", Year: 2019}, "5"},
		{aiItem{Title: "Nope", Year: 2019}, ""},
	}
	for _, c := range cases {
		if got := matchResult(c.it, res); got != c.want {
			t.Errorf("%+v: got %q want %q", c.it, got, c.want)
		}
	}
}

func TestAIClientRetriesAndNoSecrets(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-test" || r.URL.Path != "/chat/completions" {
			w.WriteHeader(401)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["response_format"].(map[string]any)["type"] != "json_object" {
			w.WriteHeader(400)
			return
		}
		if calls.Add(1) < 3 {
			w.WriteHeader(503)
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"ok\":1}"}}],"usage":{"total_tokens":42}}`))
	}))
	defer srv.Close()
	c := newAIClient(config.ForYouConfig{DeepSeekAPIKey: "sk-test", DeepSeekBaseURL: srv.URL, DeepSeekModel: "deepseek-chat"})
	c.backoff = func(int) time.Duration { return time.Millisecond }
	content, tokens, err := c.complete(context.Background(), "s", "u", 1)
	if err != nil || content != `{"ok":1}` || tokens != 42 || calls.Load() != 3 {
		t.Fatalf("complete: %q %d %v calls=%d", content, tokens, err, calls.Load())
	}
	// Retries are capped at 2; errors never carry the key or URL.
	calls.Store(-100)
	_, _, err = c.complete(context.Background(), "s", "u", 1)
	if err == nil || strings.Contains(err.Error(), "sk-test") || strings.Contains(err.Error(), srv.URL) {
		t.Fatalf("error %v", err)
	}
	if calls.Load() != -97 {
		t.Fatalf("expected 3 attempts, got %d", calls.Load()+100)
	}
	bad := newAIClient(config.ForYouConfig{DeepSeekAPIKey: "sk-wrong", DeepSeekBaseURL: srv.URL})
	bad.backoff = c.backoff
	if _, _, err := bad.complete(context.Background(), "s", "u", 1); err == nil || strings.Contains(err.Error(), "sk-wrong") {
		t.Fatalf("401: %v", err)
	}
}

func TestNextDaily(t *testing.T) {
	s := &Service{cfg: config.ForYouConfig{DailyHour: 5}}
	// 2026-10-29 01:00 UTC = 04:00 MSK → today 05:00 MSK = 02:00 UTC.
	got := s.nextDaily(time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC))
	if !got.Equal(time.Date(2026, 10, 29, 2, 0, 0, 0, time.UTC)) {
		t.Fatalf("next %v", got)
	}
	got = s.nextDaily(time.Date(2026, 10, 29, 2, 0, 0, 0, time.UTC))
	if !got.Equal(time.Date(2026, 10, 30, 2, 0, 0, 0, time.UTC)) {
		t.Fatalf("next %v", got)
	}
	s.cfg.DailyOff = true
	if s.nextDaily(now) != nil {
		t.Fatal("off")
	}
}
