package family

import (
	"math"
	"slices"
	"strings"
	"time"
)

// Signal is what a sharing profile did with one title (only what sharing
// exposes: a rating, a finished title, a favorite — never progress).
type Signal struct {
	Rating      int // 1..10, 0 = not rated
	RatedAt     time.Time
	Completed   bool
	CompletedAt time.Time
	Favorite    bool
	FavoriteAt  time.Time
}

// latest is the newest of the signal's times.
func (s Signal) latest() time.Time {
	t := s.RatedAt
	if s.CompletedAt.After(t) {
		t = s.CompletedAt
	}
	if s.FavoriteAt.After(t) {
		t = s.FavoriteAt
	}
	return t
}

// Sharer is one profile that shares with the family.
type Sharer struct {
	Person
	Signals map[string]Signal
	// Genres are the profile's taste affinities (TMDB genre id → −1…1).
	Genres map[string]float64
}

// Viewer is the profile asking for suggestions.
type Viewer struct {
	Ratings map[string]int
	Genres  map[string]float64
	// Excluded titles: rated, started/finished or dismissed by the viewer,
	// or hidden by its settings (hide_anime).
	Excluded map[string]bool
}

// Ranked is one suggested title before hydration.
type Ranked struct {
	MediaID string
	Score   float64
	People  []Endorsement
	LikedBy int
	latest  time.Time
}

const (
	// HighRating is the rating that counts as "liked" (★8+).
	HighRating = 8
	// recentWindow: a finished, unrated title counts as an endorsement when
	// it was finished within this window.
	recentWindow = 180 * 24 * time.Hour
	// minCoRated is the number of co-rated titles before ratings are used
	// for similarity at all.
	minCoRated = 2
)

// Similarity compares two profiles' tastes, −1…1. It blends rating
// agreement on co-rated titles (Pearson when both vary, else closeness)
// with the cosine of their genre affinities (from ratings, viewing and the
// taste quiz), trusting co-ratings more as they accumulate. known is false
// when there is nothing to compare.
func Similarity(a, b map[string]int, ga, gb map[string]float64) (sim float64, known bool, co int) {
	keys := make([]string, 0, len(a))
	for id := range a {
		if _, ok := b[id]; ok {
			keys = append(keys, id)
		}
	}
	slices.Sort(keys)
	xs := make([]float64, len(keys))
	ys := make([]float64, len(keys))
	for i, id := range keys {
		xs[i], ys[i] = float64(a[id]), float64(b[id])
	}
	co = len(keys)
	ts, tOK := cosine(ga, gb)
	rOK := co >= minCoRated
	var rs float64
	if rOK {
		rs = agreement(xs, ys)
	}
	n := float64(co)
	switch {
	case rOK && tOK:
		// Co-ratings dominate once there are a few; genres fill in early.
		sim = (n*rs + 3*ts) / (n + 3)
	case rOK:
		sim = rs * n / (n + 2)
	case tOK:
		sim = ts * 0.8
	default:
		return 0, false, co
	}
	return clamp(sim, -1, 1), true, co
}

// agreement of two rating vectors: Pearson correlation when both have
// spread (≥ 3 titles), blended with how close the ratings are.
func agreement(xs, ys []float64) float64 {
	n := float64(len(xs))
	var diff float64
	for i := range xs {
		diff += math.Abs(xs[i] - ys[i])
	}
	closeness := 1 - 2*(diff/n)/9 // identical → 1, 1 vs 10 → −1
	if len(xs) < 3 {
		return closeness
	}
	var mx, my float64
	for i := range xs {
		mx += xs[i]
		my += ys[i]
	}
	mx, my = mx/n, my/n
	var sxy, sxx, syy float64
	for i := range xs {
		dx, dy := xs[i]-mx, ys[i]-my
		sxy += dx * dy
		sxx += dx * dx
		syy += dy * dy
	}
	if sxx == 0 || syy == 0 {
		return closeness
	}
	return 0.7*sxy/math.Sqrt(sxx*syy) + 0.3*closeness
}

// cosine of two genre affinity vectors; false when either is too thin.
func cosine(a, b map[string]float64) (float64, bool) {
	if len(a) < 2 || len(b) < 2 {
		return 0, false
	}
	var dot, na, nb float64
	shared := 0
	for k, x := range a {
		na += x * x
		if y, ok := b[k]; ok {
			dot += x * y
			shared++
		}
	}
	for _, y := range b {
		nb += y * y
	}
	if shared == 0 || na == 0 || nb == 0 {
		return 0, false
	}
	return dot / math.Sqrt(na*nb), true
}

// MatchPercent shows a similarity as «совпадение вкусов N %».
func MatchPercent(sim float64) int {
	return int(math.Round(50 + 50*clamp(sim, -1, 1)))
}

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// contribution of one sharer's signal: >0 recommends, <0 warns. endorse
// reports whether it counts as "liked" (★8+, a favorite, or finished
// recently without a low rating).
func contribution(s Signal, now time.Time) (v float64, endorse bool) {
	switch {
	case s.Rating >= HighRating:
		v, endorse = 0.6+float64(s.Rating-HighRating)*0.2, true
	case s.Rating == 7:
		v = 0.2
	case s.Rating > 0 && s.Rating <= 5:
		v = -0.5 * float64(6-s.Rating) / 5
	case s.Rating == 0 && s.Completed:
		if now.Sub(s.CompletedAt) <= recentWindow {
			v, endorse = 0.4, true
		} else {
			v = 0.15
		}
	}
	if s.Favorite && (s.Rating == 0 || s.Rating > 5) {
		v += 0.3
		endorse = true
	}
	// Recent activity counts more (fades to 60 % over a few months).
	age := now.Sub(s.latest()).Hours() / 24
	if age < 0 {
		age = 0
	}
	return v * (0.6 + 0.4*math.Exp(-age/60)), endorse
}

// Rank scores every title a sharing profile endorsed and the viewer has
// not seen: Σ over sharers of weight(similarity) × contribution, plus a
// bonus per additional family member who liked it. Members carry the
// match percent (nil = not enough data).
func Rank(v Viewer, sharers []Sharer, now time.Time, limit int) ([]Member, []Ranked) {
	members := make([]Member, 0, len(sharers))
	weights := make([]float64, len(sharers))
	for i, s := range sharers {
		sim, known, co := Similarity(v.Ratings, ratingsOf(s.Signals), v.Genres, s.Genres)
		m := Member{Person: s.Person, CoRated: co}
		weights[i] = 1
		if known {
			p := MatchPercent(sim)
			m.Match = &p
			weights[i] = math.Max(0.15, 1+sim)
		}
		members = append(members, m)
	}
	// Best match first; unknown last; then by name.
	slices.SortStableFunc(members, func(a, b Member) int {
		am, bm := -1, -1
		if a.Match != nil {
			am = *a.Match
		}
		if b.Match != nil {
			bm = *b.Match
		}
		if am != bm {
			return bm - am
		}
		return strings.Compare(a.Name, b.Name)
	})

	type acc struct {
		r       Ranked
		contrib []float64
	}
	items := map[string]*acc{}
	for i, s := range sharers {
		for id, sg := range s.Signals {
			if v.Excluded[id] {
				continue
			}
			c, endorse := contribution(sg, now)
			a := items[id]
			if a == nil {
				a = &acc{r: Ranked{MediaID: id}}
				items[id] = a
			}
			a.r.Score += weights[i] * c
			if endorse {
				a.r.LikedBy++
			}
			if t := sg.latest(); t.After(a.r.latest) {
				a.r.latest = t
			}
			a.r.People = append(a.r.People, endorsementOf(s.Person, sg, endorse))
			a.contrib = append(a.contrib, weights[i]*c)
		}
	}
	out := make([]Ranked, 0, len(items))
	for _, a := range items {
		if a.r.LikedBy == 0 {
			continue
		}
		a.r.Score += 0.3 * float64(a.r.LikedBy-1)
		if a.r.Score <= 0 {
			continue
		}
		// Who liked it first (strongest first), then the others.
		idx := make([]int, len(a.r.People))
		for i := range idx {
			idx[i] = i
		}
		slices.SortStableFunc(idx, func(x, y int) int {
			px, py := a.r.People[x], a.r.People[y]
			if px.Liked != py.Liked {
				if px.Liked {
					return -1
				}
				return 1
			}
			if a.contrib[x] != a.contrib[y] {
				if a.contrib[x] > a.contrib[y] {
					return -1
				}
				return 1
			}
			return strings.Compare(px.Name, py.Name)
		})
		people := make([]Endorsement, len(idx))
		for i, j := range idx {
			people[i] = a.r.People[j]
		}
		a.r.People = people
		a.r.Score = math.Round(a.r.Score*1000) / 1000
		out = append(out, a.r)
	}
	slices.SortFunc(out, func(a, b Ranked) int {
		if a.Score != b.Score {
			if a.Score > b.Score {
				return -1
			}
			return 1
		}
		if c := b.latest.Compare(a.latest); c != 0 {
			return c
		}
		return strings.Compare(a.MediaID, b.MediaID)
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return members, out
}

func ratingsOf(sig map[string]Signal) map[string]int {
	out := make(map[string]int, len(sig))
	for id, s := range sig {
		if s.Rating > 0 {
			out[id] = s.Rating
		}
	}
	return out
}

func endorsementOf(p Person, s Signal, liked bool) Endorsement {
	e := Endorsement{Person: p, Completed: s.Completed, Favorite: s.Favorite, Liked: liked}
	if s.Rating > 0 {
		r := s.Rating
		e.Rating = &r
	}
	if s.Completed && !s.CompletedAt.IsZero() {
		t := s.CompletedAt
		e.CompletedAt = &t
	}
	return e
}
