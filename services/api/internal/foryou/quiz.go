package foryou

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strconv"
	"time"

	"martytv/api/internal/catalog"
	"martytv/api/internal/db"
)

// «Давайте определим ваш вкус»: a quick taste quiz per profile.
//
//   - Titles: a stream of well-known films and series across decades,
//     genres and countries (Soviet and Russian cinema included), minus what
//     the profile has rated, watched, dismissed or already answered. Each
//     answer has its usual effect: a rating goes to ratings, «Хочу
//     посмотреть» to the watchlist, «Не хочу смотреть» to the dismissals;
//     «Не смотрел(а)» is only remembered so the title isn't asked again.
//   - Questions: genres liked / disliked, eras, origins, mood, format,
//     audio, company and tolerance for violence. They nudge the taste
//     affinities (applyQuiz) and reach the AI as a structured summary
//     (quizSummary), so even a profile with no history gets sensible rows.
//   - Finishing rebuilds the rows and regenerates the AI collections (the
//     taste-note path: rate-limited per profile).

// QuizQuestion is one questionnaire question; Options are option ids (the
// clients hold the labels).
type QuizQuestion struct {
	ID      string   `json:"id"`
	Multi   bool     `json:"multi"`
	Options []string `json:"options"`
}

var quizGenreOptions = []string{"28", "12", "35", "18", "80", "53", "9648", "878", "14", "27", "10749", "16", "10751", "99", "36", "10752"}

// QuizQuestions in the order the clients ask them.
var QuizQuestions = []QuizQuestion{
	{ID: "genres_like", Multi: true, Options: quizGenreOptions},
	{ID: "genres_dislike", Multi: true, Options: quizGenreOptions},
	{ID: "eras", Multi: true, Options: []string{"old", "1970", "1980", "1990", "2000", "2010", "2020"}},
	{ID: "origins", Multi: true, Options: []string{"soviet", "russian", "usa", "uk", "europe", "korea", "anime", "asia", "india"}},
	{ID: "mood", Multi: true, Options: []string{"light", "funny", "tense", "dark", "tearjerker", "thoughtful", "epic"}},
	{ID: "format", Options: []string{"movies", "series", "both"}},
	{ID: "audio", Options: []string{"voiceover", "subtitles", "original"}},
	{ID: "company", Options: []string{"alone", "partner", "family", "friends"}},
	{ID: "intensity", Options: []string{"avoid", "some", "love"}},
}

func quizQuestion(id string) *QuizQuestion {
	for i := range QuizQuestions {
		if QuizQuestions[i].ID == id {
			return &QuizQuestions[i]
		}
	}
	return nil
}

// QuizGoal is how many rated titles make a good start.
const QuizGoal = 20

// QuizAnswers maps a question id to the chosen option ids.
type QuizAnswers map[string][]string

// QuizState is the contract's TasteQuizState.
type QuizState struct {
	Questions   []QuizQuestion `json:"questions"`
	Answers     QuizAnswers    `json:"answers"`
	Rated       int            `json:"rated"`
	Answered    int            `json:"answered"`
	Goal        int            `json:"goal"`
	StartedAt   *time.Time     `json:"started_at"`
	CompletedAt *time.Time     `json:"completed_at"`
	DismissedAt *time.Time     `json:"dismissed_at"`
}

// QuizTitleAnswer is one answered title.
type QuizTitleAnswer struct {
	MediaID string `json:"media_id"`
	Answer  string `json:"answer"`
	Rating  *int   `json:"rating,omitempty"`
}

var quizTitleAnswers = map[string]bool{"rated": true, "unseen": true, "not_interested": true, "want": true}

// validateQuizAnswers checks question/option ids (field errors keyed "questions.<id>").
func validateQuizAnswers(a QuizAnswers) map[string]string {
	f := map[string]string{}
	for id, opts := range a {
		q := quizQuestion(id)
		if q == nil {
			f["questions."+id] = "unknown question"
			continue
		}
		if !q.Multi && len(opts) > 1 {
			f["questions."+id] = "one option only"
		}
		for _, o := range opts {
			if !slices.Contains(q.Options, o) {
				f["questions."+id] = "unknown option " + strconv.Quote(o)
			}
		}
	}
	return f
}

func validateQuizTitles(items []QuizTitleAnswer) map[string]string {
	f := map[string]string{}
	if len(items) > 50 {
		f["titles"] = "at most 50 per request"
	}
	for _, it := range items {
		if !isUUID(it.MediaID) {
			f["titles.media_id"] = "must be a UUID"
		}
		if !quizTitleAnswers[it.Answer] {
			f["titles.answer"] = "must be one of rated, unseen, not_interested, want"
		}
		if it.Answer == "rated" && (it.Rating == nil || *it.Rating < 1 || *it.Rating > 10) {
			f["titles.rating"] = "rated titles need a rating from 1 to 10"
		}
	}
	return f
}

// QuizState reads the profile's quiz (an empty one when never started).
func (s *Service) QuizState(ctx context.Context, profileID string) (*QuizState, error) {
	st := &QuizState{Questions: QuizQuestions, Answers: QuizAnswers{}, Goal: QuizGoal}
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT answers, started_at, completed_at, dismissed_at FROM taste_quiz WHERE profile_id = $1`, profileID).
		Scan(&raw, &st.StartedAt, &st.CompletedAt, &st.DismissedAt)
	if err != nil && !db.IsNoRows(err) {
		return nil, err
	}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &st.Answers)
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE answer = 'rated')::int, count(*)::int FROM taste_quiz_titles WHERE profile_id = $1`, profileID).
		Scan(&st.Rated, &st.Answered); err != nil {
		return nil, err
	}
	return st, nil
}

// QuizAnswer stores questionnaire answers (merged per question; an empty
// list clears a question) and answered titles with their side effects.
func (s *Service) QuizAnswer(ctx context.Context, profileID string, questions QuizAnswers, titles []QuizTitleAnswer) (*QuizState, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `INSERT INTO taste_quiz (profile_id) VALUES ($1) ON CONFLICT DO NOTHING`, profileID); err != nil {
		return nil, err
	}
	if len(questions) > 0 {
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT answers FROM taste_quiz WHERE profile_id = $1 FOR UPDATE`, profileID).Scan(&raw); err != nil {
			return nil, err
		}
		cur := QuizAnswers{}
		_ = json.Unmarshal(raw, &cur)
		for id, opts := range questions {
			if len(opts) == 0 {
				delete(cur, id)
				continue
			}
			cur[id] = slices.Compact(slices.Sorted(slices.Values(opts)))
		}
		b, _ := json.Marshal(cur)
		if _, err := tx.Exec(ctx, `UPDATE taste_quiz SET answers = $2, updated_at = now() WHERE profile_id = $1`, profileID, b); err != nil {
			return nil, err
		}
	}
	for _, it := range titles {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM media WHERE id = $1)`, it.MediaID).Scan(&exists); err != nil {
			return nil, err
		}
		if !exists {
			return nil, errQuizUnknownTitle
		}
		var rating *int
		if it.Answer == "rated" {
			rating = it.Rating
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO taste_quiz_titles (profile_id, media_id, answer, rating) VALUES ($1, $2, $3, $4)
			ON CONFLICT (profile_id, media_id) DO UPDATE SET answer = EXCLUDED.answer, rating = EXCLUDED.rating, created_at = now()`,
			profileID, it.MediaID, it.Answer, rating); err != nil {
			return nil, err
		}
		switch it.Answer {
		case "rated":
			_, err = tx.Exec(ctx, `
				INSERT INTO ratings (profile_id, media_id, rating) VALUES ($1, $2, $3)
				ON CONFLICT (profile_id, media_id) DO UPDATE SET rating = EXCLUDED.rating, updated_at = now()`, profileID, it.MediaID, *it.Rating)
		case "want":
			_, err = tx.Exec(ctx, `INSERT INTO watchlist_items (profile_id, media_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, profileID, it.MediaID)
		case "not_interested":
			_, err = tx.Exec(ctx, `INSERT INTO foryou_dismissals (profile_id, media_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, profileID, it.MediaID)
		}
		if err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE taste_quiz SET updated_at = now() WHERE profile_id = $1`, profileID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.QuizState(ctx, profileID)
}

var errQuizUnknownTitle = errors.New("unknown title")

// QuizFinish marks the quiz done, recomputes the taste and refreshes the
// recommendations (rows now; AI collections through the taste-note path).
func (s *Service) QuizFinish(ctx context.Context, profileID, lang string) (*QuizState, bool, error) {
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO taste_quiz (profile_id, completed_at) VALUES ($1, now())
		ON CONFLICT (profile_id) DO UPDATE SET completed_at = now(), dismissed_at = NULL, updated_at = now()`, profileID); err != nil {
		return nil, false, err
	}
	ai := s.quizRefresh(ctx, profileID, lang)
	st, err := s.QuizState(ctx, profileID)
	return st, ai, err
}

// quizRefresh recomputes the taste, expires the cached rows, rebuilds them
// in the background and (with AI) regenerates the AI collections through
// the taste-note path. Reports whether the AI regenerates.
func (s *Service) quizRefresh(ctx context.Context, profileID, lang string) bool {
	if _, _, err := s.computeTaste(ctx, profileID); err != nil {
		s.log.WarnContext(ctx, "foryou: quiz taste recompute failed", "err", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE recs_cache SET expires_at = now() WHERE profile_id = $1`, profileID); err != nil {
		s.log.WarnContext(ctx, "foryou: cache invalidation failed", "err", err)
	}
	s.rebuildAsync(profileID, lang, "settings")
	ai := s.ai != nil
	if ai {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO foryou_note_regen (profile_id, note_changed_at) VALUES ($1, now())
			ON CONFLICT (profile_id) DO UPDATE SET note_changed_at = now()`, profileID); err != nil {
			s.log.WarnContext(ctx, "foryou: quiz regen mark failed", "err", err)
		} else {
			s.noteRegen(profileID)
		}
	}
	return ai
}

// QuizDismiss hides the quiz invitation (Home card / banner).
func (s *Service) QuizDismiss(ctx context.Context, profileID string) (*QuizState, error) {
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO taste_quiz (profile_id, dismissed_at) VALUES ($1, now())
		ON CONFLICT (profile_id) DO UPDATE SET dismissed_at = now(), updated_at = now()`, profileID); err != nil {
		return nil, err
	}
	return s.QuizState(ctx, profileID)
}

// quizAnswers reads the questionnaire answers (nil when none).
func (s *Service) quizAnswers(ctx context.Context, profileID string) (QuizAnswers, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT answers FROM taste_quiz WHERE profile_id = $1`, profileID).Scan(&raw)
	if db.IsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	a := QuizAnswers{}
	_ = json.Unmarshal(raw, &a)
	if len(a) == 0 {
		return nil, nil
	}
	return a, nil
}

// ---- titles ----

// quizBucket is one discover query of the title stream.
type quizBucket struct {
	kind, sort, lang string
	from, to         int
	votes            int
	genres           []int
}

// quizBuckets: global hits and classics, every decade, Soviet and Russian
// cinema, series, Korea, anime, Europe, genres people split on.
var quizBuckets = []quizBucket{
	{kind: "movie", sort: "popularity", votes: 3000},
	{kind: "movie", sort: "rating", votes: 8000},
	{kind: "movie", sort: "rating", lang: "ru", to: 1991, votes: 150},
	{kind: "series", sort: "popularity", votes: 1500},
	{kind: "movie", sort: "rating", from: 1980, to: 1989, votes: 2000},
	{kind: "movie", sort: "popularity", lang: "ru", from: 1992, votes: 150},
	{kind: "movie", sort: "rating", from: 1990, to: 1999, votes: 3000},
	{kind: "series", sort: "rating", votes: 3000},
	{kind: "movie", sort: "rating", lang: "ko", votes: 500},
	{kind: "movie", sort: "rating", lang: "ja", genres: []int{16}, votes: 800},
	{kind: "movie", sort: "rating", from: 2000, to: 2009, votes: 4000},
	{kind: "movie", sort: "rating", lang: "fr", votes: 800},
	{kind: "movie", sort: "popularity", genres: []int{27}, votes: 2000},
	{kind: "series", sort: "popularity", lang: "ru", votes: 50},
	{kind: "movie", sort: "rating", from: 2010, to: 2019, votes: 5000},
	{kind: "movie", sort: "popularity", genres: []int{35}, votes: 3000},
	{kind: "movie", sort: "rating", to: 1979, votes: 2000},
	{kind: "movie", sort: "popularity", from: 2020, votes: 1500},
	{kind: "movie", sort: "rating", genres: []int{99}, votes: 500},
	{kind: "movie", sort: "popularity", genres: []int{16, 10751}, votes: 2000},
}

func (b quizBucket) params(lang string, page int) catalog.DiscoverParams {
	p := catalog.DiscoverParams{Kind: b.kind, Sort: b.sort, Lang: lang, Page: page, OriginalLanguage: b.lang, AnyGenres: b.genres}
	if b.from > 0 {
		f := b.from
		p.YearFrom = &f
	}
	if b.to > 0 {
		t := b.to
		p.YearTo = &t
	}
	v := b.votes
	p.VoteCountMin = &v
	return p
}

// QuizTitles returns up to limit titles to ask about: one per bucket in
// turn (starting where the last batch stopped), skipping known titles.
func (s *Service) QuizTitles(ctx context.Context, profileID, lang string, limit int) ([]catalog.MediaSummary, error) {
	if !s.cat.Available() {
		return []catalog.MediaSummary{}, nil
	}
	skip, err := s.seenSet(ctx, profileID)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT media_id FROM taste_quiz_titles WHERE profile_id = $1
		UNION SELECT media_id FROM watchlist_items WHERE profile_id = $1`, profileID)
	if err != nil {
		return nil, err
	}
	answered := 0
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			skip[id] = true
			answered++
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	st, err := s.profiles.GetSettings(ctx, profileID)
	if err != nil {
		return nil, err
	}
	hideAnime := st.HideAnime != nil && *st.HideAnime

	n := len(quizBuckets)
	queues := make([][]catalog.MediaSummary, n)
	pages := make([]int, n)
	done := make([]bool, n)
	// fill tops up one bucket's queue (≤ 3 pages deep).
	fill := func(i int) {
		for len(queues[i]) == 0 && !done[i] {
			if pages[i] >= 3 {
				done[i] = true
				return
			}
			pages[i]++
			res, err := s.cat.Discover(ctx, quizBuckets[i].params(lang, pages[i]))
			if err != nil || res == nil || len(res.Items) == 0 {
				done[i] = true
				return
			}
			for _, m := range res.Items {
				if m.ID == "" || skip[m.ID] || m.PosterPath == nil || (hideAnime && quizBuckets[i].lang == "ja") {
					continue
				}
				queues[i] = append(queues[i], m)
			}
		}
	}
	out := []catalog.MediaSummary{}
	start := answered % n
	for pass := 0; len(out) < limit && pass < 4; pass++ {
		progress := false
		for k := 0; k < n && len(out) < limit; k++ {
			i := (start + k) % n
			fill(i)
			for len(queues[i]) > 0 {
				m := queues[i][0]
				queues[i] = queues[i][1:]
				if skip[m.ID] {
					continue
				}
				skip[m.ID] = true
				out = append(out, m)
				progress = true
				break
			}
		}
		if !progress {
			break
		}
	}
	return out, nil
}

// ---- taste ----

type quizBoost struct {
	genres, decades, langs, countries map[string]float64
}

func (b *quizBoost) add(m *map[string]float64, k string, v float64) {
	if *m == nil {
		*m = map[string]float64{}
	}
	(*m)[k] += v
}

// quizBoosts maps questionnaire answers to affinity nudges. Pure.
func quizBoosts(a QuizAnswers) quizBoost {
	var b quizBoost
	g := func(id int, v float64) { b.add(&b.genres, strconv.Itoa(id), v) }
	for _, o := range a["genres_like"] {
		b.add(&b.genres, o, 0.6)
	}
	for _, o := range a["genres_dislike"] {
		b.add(&b.genres, o, -0.8)
	}
	for _, o := range a["eras"] {
		if o == "old" {
			for _, d := range []string{"1940", "1950", "1960"} {
				b.add(&b.decades, d, 0.5)
			}
			continue
		}
		b.add(&b.decades, o, 0.5)
	}
	for _, o := range a["origins"] {
		switch o {
		case "soviet":
			b.add(&b.countries, "SU", 0.6)
			b.add(&b.langs, "ru", 0.3)
		case "russian":
			b.add(&b.countries, "RU", 0.6)
			b.add(&b.langs, "ru", 0.4)
		case "usa":
			b.add(&b.countries, "US", 0.4)
			b.add(&b.langs, "en", 0.2)
		case "uk":
			b.add(&b.countries, "GB", 0.5)
			b.add(&b.langs, "en", 0.1)
		case "europe":
			for _, c := range []string{"FR", "IT", "DE", "ES"} {
				b.add(&b.countries, c, 0.4)
			}
			for _, l := range []string{"fr", "it", "de", "es"} {
				b.add(&b.langs, l, 0.3)
			}
		case "korea":
			b.add(&b.countries, "KR", 0.6)
			b.add(&b.langs, "ko", 0.5)
		case "anime":
			b.add(&b.langs, "ja", 0.5)
			b.add(&b.countries, "JP", 0.4)
			g(16, 0.3)
		case "asia":
			for _, c := range []string{"CN", "HK", "TW"} {
				b.add(&b.countries, c, 0.4)
			}
			b.add(&b.langs, "zh", 0.4)
			b.add(&b.langs, "cn", 0.4)
		case "india":
			b.add(&b.countries, "IN", 0.5)
			b.add(&b.langs, "hi", 0.5)
		}
	}
	for _, o := range a["mood"] {
		switch o {
		case "light":
			g(35, 0.3)
			g(10751, 0.2)
			g(10749, 0.2)
		case "funny":
			g(35, 0.5)
		case "tense":
			g(53, 0.4)
			g(9648, 0.3)
		case "dark":
			g(80, 0.4)
			g(18, 0.2)
		case "tearjerker":
			g(18, 0.4)
			g(10749, 0.3)
		case "thoughtful":
			g(18, 0.3)
			g(878, 0.2)
			g(99, 0.2)
		case "epic":
			g(12, 0.3)
			g(14, 0.3)
			g(36, 0.2)
			g(10752, 0.2)
		}
	}
	for _, o := range a["intensity"] {
		switch o {
		case "avoid":
			g(27, -0.9)
			g(10752, -0.3)
			g(53, -0.2)
			g(80, -0.2)
		case "love":
			g(27, 0.4)
			g(53, 0.2)
		}
	}
	for _, o := range a["company"] {
		if o == "family" {
			g(10751, 0.4)
			g(16, 0.2)
			g(27, -0.4)
		}
	}
	return b
}

// mergeAffinities adds nudges to a list (clamped to ±1), re-sorted.
func mergeAffinities(list []Affinity, boost map[string]float64) []Affinity {
	if len(boost) == 0 {
		return list
	}
	idx := map[string]int{}
	for i, a := range list {
		idx[a.Key] = i
	}
	for k, v := range boost {
		if i, ok := idx[k]; ok {
			list[i].Score = round3(math.Max(-1, math.Min(1, list[i].Score+v)))
			continue
		}
		list = append(list, Affinity{Key: k, Score: round3(math.Max(-1, math.Min(1, v)))})
	}
	slices.SortStableFunc(list, func(a, b Affinity) int {
		switch {
		case a.Score > b.Score:
			return -1
		case a.Score < b.Score:
			return 1
		}
		return cmpStr(a.Key, b.Key)
	})
	return list
}

// applyQuiz nudges a computed taste by the questionnaire answers.
func applyQuiz(t *Taste, a QuizAnswers) {
	if len(a) == 0 {
		return
	}
	b := quizBoosts(a)
	t.Genres = mergeAffinities(t.Genres, b.genres)
	t.Decades = mergeAffinities(t.Decades, b.decades)
	t.Languages = mergeAffinities(t.Languages, b.langs)
	t.Countries = mergeAffinities(t.Countries, b.countries)
	t.genre, t.decade, t.lang, t.country = nil, nil, nil, nil
	t.index()
}

// quizSummary turns the answers into short English phrases for the AI.
func quizSummary(a QuizAnswers) []string {
	if len(a) == 0 {
		return nil
	}
	var out []string
	names := func(ids []string) []string {
		var r []string
		for _, id := range ids {
			n, _ := strconv.Atoi(id)
			r = append(r, staticGenreName("en", n))
		}
		return r
	}
	join := func(prefix string, v []string) {
		if len(v) > 0 {
			out = append(out, prefix+": "+joinComma(v))
		}
	}
	join("Likes genres", names(a["genres_like"]))
	join("Dislikes genres", names(a["genres_dislike"]))
	join("Favourite eras", a["eras"])
	join("Likes cinema from", a["origins"])
	join("Moods", a["mood"])
	join("Prefers", a["format"])
	join("Audio", a["audio"])
	join("Usually watches with", a["company"])
	join("Violence/horror", a["intensity"])
	return out
}

func joinComma(v []string) string {
	s := ""
	for i, x := range v {
		if i > 0 {
			s += ", "
		}
		s += x
	}
	return s
}
