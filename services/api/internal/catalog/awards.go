package catalog

import "context"

// Awards and nominations (internal/awards, from Wikidata). Like ratings
// they are decoration attached after the TMDB cache: a failure is logged and
// the details go out with an empty list. Poster badges travel with the
// ratings (TitleRatings.Award), so lists need no extra hook.

// AwardsSource is implemented by the awards module.
type AwardsSource interface {
	// DetailAwards returns a title's grouped awards in lang (stored rows
	// only: a never-checked title is fetched in the background).
	DetailAwards(ctx context.Context, id, lang string) ([]AwardGroup, error)
}

// SetAwards enables the `awards` list of media details.
func (h *Handlers) SetAwards(a AwardsSource) { h.awards = a }

func (h *Handlers) detailAwards(ctx context.Context, d *MediaDetail, lang string) {
	d.Awards = []AwardGroup{}
	if h.awards == nil {
		return
	}
	groups, err := h.awards.DetailAwards(ctx, d.ID, lang)
	if err != nil {
		h.svc.log.WarnContext(ctx, "awards lookup failed", "err", err)
		return
	}
	if groups != nil {
		d.Awards = groups
	}
}
