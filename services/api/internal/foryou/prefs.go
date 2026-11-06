package foryou

import (
	"context"
	"strings"
	"time"

	"martytv/api/internal/db"
	"martytv/api/internal/profiles"
)

// Profile preferences that steer recommendations (profile settings):
//
//   - min_votes: the TMDB vote-count floor of discover queries (Explore
//     tiles, Surprise Me's fallback, «Для вас» candidates). Each query keeps
//     its own tuned floor at the default (100); a higher choice raises every
//     floor to at least that value; a lower one scales them down.
//   - taste_note («О моих вкусах»): the viewer's own words, sent to DeepSeek
//     as delimited data. A change marks the AI collections stale and
//     regenerates them for that profile in the background, at most once per
//     noteRegenEvery.

const (
	noteRegenEvery = 30 * time.Minute
	// ratedFloor: rating-sorted queries never go below this many votes (a
	// 10.0 from one vote is noise, whatever the setting).
	ratedFloor = 10
)

func minVotesOf(st profiles.Settings) int {
	if st.MinVotes == nil {
		return profiles.DefaultMinVotes
	}
	return *st.MinVotes
}

func tasteNoteOf(st profiles.Settings) string {
	if st.TasteNote == nil {
		return ""
	}
	return *st.TasteNote
}

// votesFloor maps a query's tuned floor (at the default min_votes) to the
// profile's choice.
func votesFloor(base, mv int) int {
	switch {
	case mv == profiles.DefaultMinVotes:
		return base
	case mv > profiles.DefaultMinVotes:
		return max(base, mv)
	}
	return base * mv / profiles.DefaultMinVotes
}

// ratedVotesFloor is votesFloor for rating-sorted queries.
func ratedVotesFloor(base, mv int) int { return max(votesFloor(base, mv), ratedFloor) }

// hiddenGemVotes is the hidden-gems window: the floor follows the setting,
// the ceiling stays ≥ 1500 and at least 3× the floor (so raising min_votes
// keeps the row "lesser-known among the well-known" instead of empty).
func hiddenGemVotes(mv int) (lo, hi int) {
	lo = ratedVotesFloor(150, mv)
	return lo, max(1500, lo*3)
}

// minVotes reads a profile's min_votes (default on errors).
func (s *Service) minVotes(ctx context.Context, profileID string) int {
	st, err := s.profiles.GetSettings(ctx, profileID)
	if err != nil {
		return profiles.DefaultMinVotes
	}
	return minVotesOf(st)
}

// viewerNote is the taste note as it may be sent to the model: cleaned
// (one line, ≤ 600 chars), or "" when it looks like an attempt to override
// the rules or extract the prompt (neutralized: the note is just left out).
func viewerNote(note string) string {
	note = clip(cleanText(note), profiles.TasteNoteMax)
	if note == "" || looksLikeInjection(note) || leaksPrompt(note) {
		return ""
	}
	return note
}

// SettingsChanged is registered with the profiles handlers: a changed
// min_votes rebuilds the rows (tile counts are keyed by min_votes); a
// changed taste note marks the AI collections stale and regenerates them.
func (s *Service) SettingsChanged(ctx context.Context, profileID string, before, after profiles.Settings) {
	if minVotesOf(before) != minVotesOf(after) {
		if _, err := s.pool.Exec(ctx, `UPDATE recs_cache SET expires_at = now() WHERE profile_id = $1`, profileID); err != nil {
			s.log.WarnContext(ctx, "foryou: cache invalidation failed", "err", err)
		}
		s.rebuildAsync(profileID, s.profileLang(ctx, profileID), "settings")
	}
	if strings.TrimSpace(tasteNoteOf(before)) != strings.TrimSpace(tasteNoteOf(after)) {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO foryou_note_regen (profile_id, note_changed_at) VALUES ($1, now())
			ON CONFLICT (profile_id) DO UPDATE SET note_changed_at = now()`, profileID); err != nil {
			s.log.WarnContext(ctx, "foryou: taste note mark failed", "err", err)
			return
		}
		s.noteRegen(profileID)
	}
}

// noteRegen starts a background AI regeneration for the profile when its
// collections are stale (note changed since they were last generated) and
// the last note-triggered regeneration is older than noteRegenEvery.
// Otherwise, while still stale, it retries once the window has passed.
func (s *Service) noteRegen(profileID string) {
	if s.ai == nil {
		return
	}
	ctx := s.base()
	var claimed bool
	err := s.pool.QueryRow(ctx, `
		UPDATE foryou_note_regen SET regen_at = now()
		WHERE profile_id = $1 AND (applied_at IS NULL OR note_changed_at > applied_at)
		  AND (regen_at IS NULL OR regen_at <= now() - $2::interval)
		RETURNING true`, profileID, noteRegenEvery).Scan(&claimed)
	if err != nil && !db.IsNoRows(err) {
		s.log.Warn("foryou: taste note regeneration check failed", "err", err)
		return
	}
	if !claimed {
		// Rate-limited (or nothing stale): retry after the window, once.
		var secs float64
		if err := s.pool.QueryRow(ctx, `
			SELECT COALESCE(extract(epoch FROM regen_at + $2::interval - now()), -1)::float8 FROM foryou_note_regen
			WHERE profile_id = $1 AND (applied_at IS NULL OR note_changed_at > applied_at)`, profileID, noteRegenEvery).Scan(&secs); err != nil {
			return // not stale
		}
		wait := time.Duration(secs*float64(time.Second)) + time.Second
		if wait <= 0 {
			return
		}
		if _, pending := s.noteTimers.LoadOrStore(profileID, struct{}{}); pending {
			return
		}
		time.AfterFunc(wait, func() {
			s.noteTimers.Delete(profileID)
			if s.base().Err() == nil {
				s.noteRegen(profileID)
			}
		})
		return
	}
	if _, err := s.startProfileRegen(ctx, profileID, "taste_note", ""); err != nil {
		s.log.Warn("foryou: taste note regeneration not started", "err", err)
	}
}

// markNoteApplied records that the profile's collections were generated
// with its current note.
func (s *Service) markNoteApplied(ctx context.Context, profileID string) {
	if _, err := s.pool.Exec(ctx, `UPDATE foryou_note_regen SET applied_at = now() WHERE profile_id = $1`, profileID); err != nil {
		s.log.Warn("foryou: taste note mark failed", "err", err)
	}
}
