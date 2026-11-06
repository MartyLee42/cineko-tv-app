package foryou

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strconv"
	"time"
)

// «✨ Заполнить по моим фильмам»: the questionnaire answers derived from what
// the profile actually watched — deterministic, no AI needed. Regenerating
// overwrites every question it can infer (genres liked / disliked, eras,
// origins, mood, format, intensity); audio and company can't be read from
// history, so the viewer's own answers to them stay.
//
// Evidence per title (recency-weighted like the taste):
//   - liked: rating ≥ 7 ((r−6)/4), finished without a rating (0.5),
//     favourite (+0.5), rewatches (+0.2 each, ≤ 3), watchlist (0.15, weak).
//   - disliked: rating ≤ 4 ((5−r)/4), abandoned (0.5), «Не интересно» (0.3),
//     a note saying why it didn't work (0.4).
//
// Ratings 5–6 are neutral. A genre is only "disliked" with negative evidence
// on at least two titles outweighing the positive — never for being absent.

// QuizGenMinTitles: fewer rated / finished / favourite titles → 409.
const QuizGenMinTitles = 3

// quizGenQuestions are the questions a generation overwrites.
var quizGenQuestions = []string{"genres_like", "genres_dislike", "eras", "origins", "mood", "format", "intensity"}

// QuizBasis is what a generation was based on (contract TasteQuizBasis).
type QuizBasis struct {
	Titles    int `json:"titles"` // rated, finished or favourite titles
	Rated     int `json:"rated"`
	Completed int `json:"completed"`
	Favorites int `json:"favorites"`
	Liked     int `json:"liked"`
	Disliked  int `json:"disliked"`
}

var errQuizNotEnough = errors.New("not enough history")

// moodGenres: which genres hint at which mood (weight per genre).
var moodGenres = map[string]map[int]float64{
	"funny":      {35: 1},
	"light":      {10751: 1, 16: 0.8, 10749: 0.5, 35: 0.4},
	"tense":      {53: 1, 9648: 1},
	"dark":       {80: 1, 27: 0.8},
	"tearjerker": {10749: 0.6, 18: 0.6},
	"thoughtful": {18: 0.6, 878: 0.5, 99: 1, 36: 0.5},
	"epic":       {12: 0.8, 14: 1, 36: 0.6, 10752: 1},
}

var europeCountries = []string{"FR", "IT", "DE", "ES", "SE", "DK", "NO", "FI", "PL", "BE", "NL", "AT", "CH", "IE", "PT", "CZ"}
var europeLangs = []string{"fr", "it", "de", "es", "sv", "da", "no", "fi", "pl", "nl", "pt", "cs"}

// titleOrigins maps a title to the quiz's origin options.
func titleOrigins(f Features) []string {
	var out []string
	has := func(cs ...string) bool {
		return slices.ContainsFunc(f.Countries, func(c string) bool { return slices.Contains(cs, c) })
	}
	none := len(f.Countries) == 0
	anime := f.Lang == "ja" && slices.Contains(f.Genres, 16)
	switch {
	case anime:
		out = append(out, "anime")
	case has("SU") || (none && f.Lang == "ru" && f.Year > 0 && f.Year < 1992):
		out = append(out, "soviet")
	case has("RU") || (none && f.Lang == "ru"):
		out = append(out, "russian")
	}
	if has("US") || (none && f.Lang == "en") {
		out = append(out, "usa")
	}
	if has("GB") {
		out = append(out, "uk")
	}
	if has(europeCountries...) || (none && slices.Contains(europeLangs, f.Lang)) {
		out = append(out, "europe")
	}
	if has("KR") || f.Lang == "ko" {
		out = append(out, "korea")
	}
	if has("CN", "HK", "TW") || f.Lang == "zh" || f.Lang == "cn" {
		out = append(out, "asia")
	}
	if has("IN") || f.Lang == "hi" || f.Lang == "ta" || f.Lang == "te" {
		out = append(out, "india")
	}
	return slices.Compact(out)
}

func titleEra(year int) string {
	switch {
	case year <= 0:
		return ""
	case year < 1970:
		return "old"
	case year >= 2020:
		return "2020"
	}
	return strconv.Itoa(year / 10 * 10)
}

// titleEvidence is one title's liked / disliked strength (both ≥ 0).
func titleEvidence(s Signal, now time.Time, w Weights) (pos, neg float64) {
	switch {
	case s.Rating >= 7:
		pos += float64(s.Rating-6) / 4
	case s.Rating > 0 && s.Rating <= 4:
		neg += float64(5-s.Rating) / 4
	case s.Rating == 0 && s.Completed:
		pos += 0.5
	}
	if s.Favorite {
		pos += 0.5
	}
	pos += 0.2 * float64(min(s.Rewatches, 3))
	if s.Watchlist && !s.Completed && s.Rating == 0 {
		pos += 0.15
	}
	if abandoned(s, now, w) {
		neg += 0.5
	}
	if s.Dismissed {
		neg += 0.3
	}
	if slices.ContainsFunc(s.NoteReasons, negativeReason) {
		neg += 0.4
	}
	_, at := signalWeight(s, 6.5, now, w)
	age := max(now.Sub(at), 0)
	rec := w.RecencyFloor + (1-w.RecencyFloor)*math.Pow(0.5, float64(age)/float64(w.RecencyHalfLife))
	return pos * rec, neg * rec
}

type genAcc struct {
	pos, neg   float64
	posN, negN int
}

// GenerateQuizAnswers derives the questionnaire answers from the signals.
// Pure and deterministic; only the questions in quizGenQuestions are set
// (an absent key = nothing to say, which clears that question).
func GenerateQuizAnswers(signals []Signal, feats map[string]Features, now time.Time, w Weights) (QuizAnswers, QuizBasis) {
	var b QuizBasis
	genres, eras, origins, moods := map[string]*genAcc{}, map[string]*genAcc{}, map[string]*genAcc{}, map[string]*genAcc{}
	get := func(m map[string]*genAcc, k string) *genAcc {
		a := m[k]
		if a == nil {
			a = &genAcc{}
			m[k] = a
		}
		return a
	}
	totalPos, seriesPos := 0.0, 0.0
	posTitles := 0
	for _, s := range signals {
		f, ok := feats[s.MediaID]
		if !ok {
			continue
		}
		if s.Rating > 0 || s.Completed || s.Favorite {
			b.Titles++
		}
		if s.Rating > 0 {
			b.Rated++
		}
		if s.Completed {
			b.Completed++
		}
		if s.Favorite {
			b.Favorites++
		}
		pos, neg := titleEvidence(s, now, w)
		if pos == 0 && neg == 0 {
			continue
		}
		// Net per title: a favourite rated 3 is still mostly a dislike.
		if pos >= neg {
			pos, neg = pos-neg, 0
		} else {
			pos, neg = 0, neg-pos
		}
		if pos > 0 {
			b.Liked++
			posTitles++
			totalPos += pos
			if f.Kind == "series" {
				seriesPos += pos
			}
		} else {
			b.Disliked++
		}
		add := func(a *genAcc) {
			a.pos += pos
			a.neg += neg
			if pos > 0 {
				a.posN++
			} else {
				a.negN++
			}
		}
		for _, g := range slices.Compact(slices.Sorted(slices.Values(f.Genres))) {
			add(get(genres, strconv.Itoa(g)))
		}
		if e := titleEra(f.Year); e != "" {
			add(get(eras, e))
		}
		for _, o := range titleOrigins(f) {
			add(get(origins, o))
		}
		for m, gs := range moodGenres {
			best := 0.0
			for _, g := range f.Genres {
				best = math.Max(best, gs[g])
			}
			if best > 0 {
				a := get(moods, m)
				a.pos += pos * best
				a.neg += neg * best
				if pos > 0 {
					a.posN++
				} else {
					a.negN++
				}
			}
		}
	}
	out := QuizAnswers{}
	if totalPos > 0 {
		like := pickTop(genres, 5, func(a *genAcc) bool { return a.posN >= 2 && a.pos > a.neg && a.pos/totalPos >= 0.2 })
		if len(like) == 0 {
			like = pickTop(genres, 1, func(a *genAcc) bool { return a.posN >= 2 && a.pos > a.neg })
		}
		like = slices.DeleteFunc(like, func(k string) bool { return !slices.Contains(quizGenreOptions, k) })
		setAns(out, "genres_like", like)
		setAns(out, "eras", pickTop(eras, 3, func(a *genAcc) bool { return a.posN >= 2 && a.pos > a.neg && a.pos/totalPos >= 0.2 }))
		setAns(out, "origins", pickTop(origins, 4, func(a *genAcc) bool { return a.posN >= 2 && a.pos > a.neg && a.pos/totalPos >= 0.15 }))
		setAns(out, "mood", pickTop(moods, 3, func(a *genAcc) bool { return a.posN >= 2 && a.pos > a.neg && a.pos/totalPos >= 0.25 }))
		if posTitles >= 3 {
			switch share := seriesPos / totalPos; {
			case share >= 0.65:
				out["format"] = []string{"series"}
			case share <= 0.2:
				out["format"] = []string{"movies"}
			default:
				out["format"] = []string{"both"}
			}
		}
	}
	dislike := pickTopBy(genres, 4, func(a *genAcc) float64 { return a.neg }, func(a *genAcc) bool { return a.negN >= 2 && a.neg > a.pos })
	dislike = slices.DeleteFunc(dislike, func(k string) bool {
		return !slices.Contains(quizGenreOptions, k) || slices.Contains(out["genres_like"], k)
	})
	setAns(out, "genres_dislike", dislike)

	// Intensity: horror liked → love; horror disliked or «слишком страшно»
	// notes → avoid; enjoys thrillers / crime / action / war → some.
	scary := 0
	for _, s := range signals {
		if slices.Contains(s.NoteReasons, "too_scary") {
			scary++
		}
	}
	horror := genres["27"]
	switch {
	case slices.Contains(out["genres_like"], "27") || (horror != nil && horror.posN >= 2 && horror.pos > horror.neg && totalPos > 0 && horror.pos/totalPos >= 0.15):
		out["intensity"] = []string{"love"}
	case slices.Contains(out["genres_dislike"], "27") || scary >= 2:
		out["intensity"] = []string{"avoid"}
	default:
		hard := 0.0
		for _, g := range []string{"53", "80", "28", "10752"} {
			if a := genres[g]; a != nil && a.pos > a.neg {
				hard = math.Max(hard, a.pos)
			}
		}
		if totalPos > 0 && hard/totalPos >= 0.2 {
			out["intensity"] = []string{"some"}
		}
	}
	return out, b
}

func setAns(a QuizAnswers, q string, v []string) {
	if len(v) > 0 {
		a[q] = slices.Sorted(slices.Values(v))
	}
}

func pickTop(m map[string]*genAcc, n int, ok func(*genAcc) bool) []string {
	return pickTopBy(m, n, func(a *genAcc) float64 { return a.pos - a.neg }, ok)
}

// pickTopBy: up to n keys passing ok, by score desc (ties by key).
func pickTopBy(m map[string]*genAcc, n int, score func(*genAcc) float64, ok func(*genAcc) bool) []string {
	var keys []string
	for k, a := range m {
		if ok(a) {
			keys = append(keys, k)
		}
	}
	slices.SortFunc(keys, func(x, y string) int {
		if sx, sy := score(m[x]), score(m[y]); sx != sy {
			if sx > sy {
				return -1
			}
			return 1
		}
		return cmpStr(x, y)
	})
	return limit(keys, n)
}

// QuizGenerated is the contract's TasteQuizGenerated.
type QuizGenerated struct {
	State          *QuizState `json:"state"`
	Basis          QuizBasis  `json:"basis"`
	AIRegeneration bool       `json:"ai_regeneration"`
}

// QuizGenerate fills the questionnaire from the profile's history, saves
// it (overwriting the generated questions) and refreshes the
// recommendations like finishing the quiz does.
func (s *Service) QuizGenerate(ctx context.Context, profileID, lang string) (*QuizGenerated, error) {
	signals, err := s.loadSignals(ctx, profileID)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(signals))
	for i, sg := range signals {
		ids[i] = sg.MediaID
	}
	facts, err := s.loadFeatures(ctx, ids)
	if err != nil {
		return nil, err
	}
	feats := make(map[string]Features, len(facts))
	for id, f := range facts {
		feats[id] = f.Features
	}
	gen, basis := GenerateQuizAnswers(signals, feats, s.now(), s.w)
	if basis.Titles < QuizGenMinTitles {
		return &QuizGenerated{Basis: basis}, errQuizNotEnough
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `INSERT INTO taste_quiz (profile_id) VALUES ($1) ON CONFLICT DO NOTHING`, profileID); err != nil {
		return nil, err
	}
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT answers FROM taste_quiz WHERE profile_id = $1 FOR UPDATE`, profileID).Scan(&raw); err != nil {
		return nil, err
	}
	cur := QuizAnswers{}
	_ = json.Unmarshal(raw, &cur)
	for _, q := range quizGenQuestions {
		delete(cur, q)
		if v := gen[q]; len(v) > 0 {
			cur[q] = v
		}
	}
	nb, _ := json.Marshal(cur)
	if _, err := tx.Exec(ctx, `UPDATE taste_quiz SET answers = $2, updated_at = now() WHERE profile_id = $1`, profileID, nb); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	ai := s.quizRefresh(ctx, profileID, lang)
	st, err := s.QuizState(ctx, profileID)
	if err != nil {
		return nil, err
	}
	return &QuizGenerated{State: st, Basis: basis, AIRegeneration: ai}, nil
}
