package catalog

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
)

// Profile-aware catalog (Phase 5).
//
// With ?profile_id the handlers validate that the caller may use the profile,
// apply its filters (hide_anime; hide_watched where the endpoint supports it)
// and annotate every MediaSummary with `me`. All of it happens AFTER the
// TMDB cache, so cached bodies stay profile-independent. Filtering shrinks a
// page below 20 items; page/total_pages/total_results remain TMDB's numbers.

// GenreAnimation is TMDB's "Animation" genre id (same for movies and tv).
const GenreAnimation = 16

// Viewer is the resolved profile of a personalized request.
type Viewer struct {
	ProfileID   string
	HideAnime   bool
	HideWatched bool
}

// Personalizer is implemented by the watch module. The catalog depends only
// on this interface.
type Personalizer interface {
	// Viewer checks the caller may use the profile (else returns a 404
	// error) and returns its catalog filters.
	Viewer(c fiber.Ctx, profileID string) (*Viewer, error)
	// UserStates returns the profile's state for each id in ONE query. Ids
	// without any state may be missing from the map.
	UserStates(ctx context.Context, profileID string, ids []string) (map[string]MediaUserState, error)
}

// SetPersonalizer enables ?profile_id handling.
func (h *Handlers) SetPersonalizer(p Personalizer) { h.personal = p }

// viewer parses profile_id/hide_watched. It returns nil when the request is
// not personalized. withHideWatched says whether the endpoint applies the
// hide_watched filter at all.
func (h *Handlers) viewer(c fiber.Ctx, v *validator, withHideWatched bool) (*Viewer, error) {
	pid := c.Query("profile_id")
	hw := c.Query("hide_watched")
	var override *bool
	switch strings.ToLower(hw) {
	case "":
	case "true", "1":
		override = ptrBool(true)
	case "false", "0":
		override = ptrBool(false)
	default:
		v.fields["hide_watched"] = "must be true or false"
	}
	if pid == "" {
		return nil, nil
	}
	if _, err := uuid.Parse(pid); err != nil || len(pid) != 36 {
		v.fields["profile_id"] = "must be a UUID"
		return nil, nil
	}
	if len(v.fields) > 0 || h.personal == nil {
		return nil, nil
	}
	vw, err := h.personal.Viewer(c, strings.Clone(pid))
	if err != nil {
		return nil, err
	}
	if override != nil {
		vw.HideWatched = *override
	}
	if !withHideWatched {
		vw.HideWatched = false
	}
	return vw, nil
}

func ptrBool(b bool) *bool { return &b }

// personalize annotates (and, with filter, filters) the given lists in place
// using a single batched state query.
func (h *Handlers) personalize(ctx context.Context, vw *Viewer, filter bool, lists ...*[]MediaSummary) error {
	if vw == nil {
		return nil
	}
	var ids []string
	for _, l := range lists {
		for _, it := range *l {
			ids = append(ids, it.ID)
		}
	}
	states := map[string]MediaUserState{}
	if len(ids) > 0 {
		var err error
		if states, err = h.personal.UserStates(ctx, vw.ProfileID, ids); err != nil {
			return err
		}
	}
	for _, l := range lists {
		out := make([]MediaSummary, 0, len(*l))
		for _, it := range *l {
			st := states[it.ID]
			if filter && vw.HideAnime && IsAnime(it.GenreIDs, it.origLang) {
				continue
			}
			if filter && vw.HideWatched && st.Completed {
				continue
			}
			it.Me = &st
			out = append(out, it)
		}
		*l = out
	}
	return nil
}

// IsAnime is the hide_anime rule: TMDB Animation genre AND original language ja.
func IsAnime(genreIDs []int, originalLanguage string) bool {
	return originalLanguage == "ja" && slices.Contains(genreIDs, GenreAnimation)
}

// SummariesByID reads stored titles as MediaSummary (for lists, history and
// continue-watching). Unknown ids are skipped.
func (s *Service) SummariesByID(ctx context.Context, ids []string, lang string) (map[string]MediaSummary, error) {
	out := make(map[string]MediaSummary, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.kind, m.tmdb_id, m.original_title, m.original_language, m.release_date, m.year,
		       m.poster_path, m.backdrop_path, m.vote_average, m.vote_count, m.translations,
		       m.kp_rating, m.imdb_rating,
		       COALESCE((SELECT array_agg(g.genre_id ORDER BY g.position, g.genre_id) FROM media_genres g WHERE g.media_id = m.id), '{}')
		FROM media m WHERE m.id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			m                MediaSummary
			release          *time.Time
			poster, backdrop *string
			avg              float64
			trs              map[string]translation
			genres           []int32
			kp, imdb         *float64
		)
		if err := rows.Scan(&m.ID, &m.Kind, &m.TMDBID, &m.OriginalTitle, &m.origLang, &release, &m.Year,
			&poster, &backdrop, &avg, &m.VoteCount, &trs, &kp, &imdb, &genres); err != nil {
			return nil, err
		}
		t, en := trs[lang], trs["en"]
		m.Title = firstNonEmpty(t.Title, en.Title, m.OriginalTitle)
		m.Overview = firstNonEmpty(t.Overview, en.Overview)
		m.PosterPath = firstNonNil(t.PosterPath, poster)
		m.BackdropPath = firstNonNil(t.BackdropPath, backdrop)
		m.ReleaseDate = fmtDate(release)
		m.Rating = rating(avg, m.VoteCount)
		m.KPRating, m.IMDbRating = RoundRating(kp), RoundRating(imdb)
		m.GenreIDs = make([]int, len(genres))
		for i, g := range genres {
			m.GenreIDs[i] = int(g)
		}
		out[m.ID] = m
	}
	return out, rows.Err()
}

// Annotate attaches `me` to items without filtering (used by the watch
// module's own lists).
func Annotate(items []MediaSummary, states map[string]MediaUserState) {
	for i := range items {
		st := states[items[i].ID]
		items[i].Me = &st
	}
}
