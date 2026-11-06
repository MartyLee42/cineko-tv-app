package catalog

import (
	"context"
	"math"
)

// Kinopoisk/IMDb ratings (internal/ratings).
//
// Like personalization, ratings are attached AFTER the TMDB cache, so cached
// bodies stay rating-free. Ratings are global (not per profile) and are
// annotated with one batched read per response. They are decoration: a
// failure is logged and the response goes out without them.

// TitleRatings are the stored Kinopoisk-side facts of one title.
type TitleRatings struct {
	KP   *float64
	IMDb *float64
	KPID *int
	// Award is the poster badge for tier-1 wins (internal/awards adds it
	// with one batched read; nil = none).
	Award *AwardBadge
}

// RatingsSource is implemented by the ratings module.
type RatingsSource interface {
	// Ratings returns stored ratings for ids in ONE query and schedules
	// missing lookups / stale refreshes in the background.
	Ratings(ctx context.Context, ids []string) (map[string]TitleRatings, error)
	// DetailRatings is for a details page: it may resolve/refresh
	// synchronously within a short deadline.
	DetailRatings(ctx context.Context, id string) (TitleRatings, error)
}

// SetRatings enables kp_rating/imdb_rating annotation.
func (h *Handlers) SetRatings(r RatingsSource) { h.ratings = r }

func (h *Handlers) annotateRatings(ctx context.Context, lists ...*[]MediaSummary) {
	if h.ratings == nil {
		return
	}
	var ids []string
	for _, l := range lists {
		for _, it := range *l {
			ids = append(ids, it.ID)
		}
	}
	if len(ids) == 0 {
		return
	}
	rs, err := h.ratings.Ratings(ctx, ids)
	if err != nil {
		h.svc.log.WarnContext(ctx, "ratings lookup failed", "err", err)
		return
	}
	for _, l := range lists {
		for i := range *l {
			r := rs[(*l)[i].ID]
			(*l)[i].KPRating, (*l)[i].IMDbRating, (*l)[i].AwardBadge = r.KP, r.IMDb, r.Award
		}
	}
}

func (h *Handlers) detailRatings(ctx context.Context, d *MediaDetail) {
	if h.ratings == nil {
		return
	}
	r, err := h.ratings.DetailRatings(ctx, d.ID)
	if err != nil {
		h.svc.log.WarnContext(ctx, "ratings lookup failed", "err", err)
		return
	}
	d.KPRating, d.IMDbRating, d.AwardBadge = r.KP, r.IMDb, r.Award
	if r.KPID != nil {
		d.ExternalIDs.Kinopoisk = r.KPID
	}
}

// RoundRating rounds a 0–10 rating to one decimal, as Kinopoisk shows it
// (8.501 → 8.5).
func RoundRating(r *float64) *float64 {
	if r == nil {
		return nil
	}
	v := math.Round(*r*10) / 10
	return &v
}
