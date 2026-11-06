package watch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/catalog"
	"martytv/api/internal/httpx"
)

// Admin views (Phase 5): who is watching now, and a user's history across
// profiles. Users are told in their settings that admins can see these.

// LiveStates is the realtime hub's view of connected TVs.
type LiveStates interface {
	LiveStates() map[string]json.RawMessage
	IsOnline(deviceID string) bool
}

// activeWindow: a session that has not reported for this long is not "now".
const activeWindow = 3 * time.Minute

type UserRef struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

type DeviceRef struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Online bool   `json:"online"`
}

type ActivityItem struct {
	User            UserRef              `json:"user"`
	Profile         *ProfileRef          `json:"profile"`
	Device          *DeviceRef           `json:"device"`
	Media           catalog.MediaSummary `json:"media"`
	EpisodeLabel    *string              `json:"episode_label"`
	Player          *string              `json:"player"`
	PositionSeconds *float64             `json:"position_seconds"`
	DurationSeconds *float64             `json:"duration_seconds"`
	State           string               `json:"state"`
	StartedAt       time.Time            `json:"started_at"`
	UpdatedAt       time.Time            `json:"updated_at"`

	userID, profileID, deviceID, mediaID string
	episodeID                            *string
}

// tvState is the part of the contract's DeviceState the activity view reads.
type tvState struct {
	Screen    string  `json:"screen"`
	ProfileID *string `json:"profile_id"`
	Playback  *struct {
		MediaID         string   `json:"media_id"`
		EpisodeID       *string  `json:"episode_id"`
		EpisodeLabel    *string  `json:"episode_label"`
		PositionSeconds float64  `json:"position_seconds"`
		DurationSeconds *float64 `json:"duration_seconds"`
		Paused          bool     `json:"paused"`
		Buffering       bool     `json:"buffering"`
	} `json:"playback"`
}

func sessionState(lastSeq int64, last *string) string {
	if lastSeq < 0 || last == nil {
		return "preparing"
	}
	switch *last {
	case "playing":
		return "playing"
	case "paused":
		return "paused"
	case "seeking":
		return "buffering"
	}
	return "unknown"
}

// Activity merges active playback sessions with live TV player states. A
// TV's live state is fresher than its session, so it wins for that device.
func (s *Service) Activity(ctx context.Context, live LiveStates, lang string) ([]ActivityItem, error) {
	now := s.now().UTC()
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (COALESCE(s.device_id::text, s.id::text))
		       s.id, p.user_id, s.profile_id, s.device_id, s.media_id, s.episode_id,
		       s.last_seq, s.last_state, s.last_position, s.last_duration, s.started_at, s.updated_at
		FROM playback_sessions s JOIN profiles p ON p.id = s.profile_id
		WHERE s.ended_at IS NULL AND s.updated_at > now() - $1::interval
		ORDER BY COALESCE(s.device_id::text, s.id::text), s.started_at DESC`, activeWindow)
	if err != nil {
		return nil, err
	}
	var items []*ActivityItem
	byDevice := map[string]*ActivityItem{}
	for rows.Next() {
		var (
			it    ActivityItem
			sid   string
			devID *string
			seq   int64
			state *string
			pos   float64
			dur   *float64
		)
		if err := rows.Scan(&sid, &it.userID, &it.profileID, &devID, &it.mediaID, &it.episodeID,
			&seq, &state, &pos, &dur, &it.StartedAt, &it.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		it.State = sessionState(seq, state)
		if seq >= 0 {
			it.PositionSeconds, it.DurationSeconds = &pos, dur
		}
		if devID != nil {
			it.deviceID = *devID
			byDevice[*devID] = &it
		}
		items = append(items, &it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	builtin := "builtin"
	for devID, raw := range live.LiveStates() {
		var st tvState
		if json.Unmarshal(raw, &st) != nil || st.Screen != "player" || st.Playback == nil || !isUUID(st.Playback.MediaID) {
			continue
		}
		it := byDevice[devID]
		if it == nil || it.mediaID != st.Playback.MediaID {
			if it == nil {
				it = &ActivityItem{StartedAt: now}
				items = append(items, it)
				byDevice[devID] = it
			}
			it.deviceID, it.mediaID, it.episodeID = devID, st.Playback.MediaID, st.Playback.EpisodeID
			if st.ProfileID != nil && isUUID(*st.ProfileID) {
				it.profileID = *st.ProfileID
			}
		}
		pos := st.Playback.PositionSeconds
		it.PositionSeconds, it.DurationSeconds = &pos, st.Playback.DurationSeconds
		it.EpisodeLabel = st.Playback.EpisodeLabel
		it.Player = &builtin
		it.UpdatedAt = now
		switch {
		case st.Playback.Buffering:
			it.State = "buffering"
		case st.Playback.Paused:
			it.State = "paused"
		default:
			it.State = "playing"
		}
	}
	if len(items) == 0 {
		return []ActivityItem{}, nil
	}

	// Resolve users, profiles, devices, episodes and media in a few batched queries.
	var profIDs, devIDs, mediaIDs, epIDs []string
	for _, it := range items {
		if it.profileID != "" {
			profIDs = append(profIDs, it.profileID)
		}
		if it.deviceID != "" {
			devIDs = append(devIDs, it.deviceID)
		}
		mediaIDs = append(mediaIDs, it.mediaID)
		if it.episodeID != nil && isUUID(*it.episodeID) {
			epIDs = append(epIDs, *it.episodeID)
		}
	}
	type profInfo struct {
		ref    ProfileRef
		userID string
	}
	profs := map[string]profInfo{}
	if err := s.scanEach(ctx, `SELECT id, name, color, user_id FROM profiles WHERE id = ANY($1::uuid[])`, profIDs, func(sc func(...any) error) error {
		var p profInfo
		if err := sc(&p.ref.ID, &p.ref.Name, &p.ref.Color, &p.userID); err != nil {
			return err
		}
		profs[p.ref.ID] = p
		return nil
	}); err != nil {
		return nil, err
	}
	type devInfo struct{ name, owner string }
	devs := map[string]devInfo{}
	if err := s.scanEach(ctx, `SELECT id, name, owner_user_id FROM devices WHERE id = ANY($1::uuid[])`, devIDs, func(sc func(...any) error) error {
		var id string
		var d devInfo
		if err := sc(&id, &d.name, &d.owner); err != nil {
			return err
		}
		devs[id] = d
		return nil
	}); err != nil {
		return nil, err
	}
	labels := map[string]string{}
	if err := s.scanEach(ctx, `SELECT id, season_number, episode_number,
			COALESCE(NULLIF(translations -> $2::text ->> 'name', ''), translations -> 'en' ->> 'name', '')
			FROM episodes WHERE id = ANY($1::uuid[])`, epIDs, func(sc func(...any) error) error {
		var id, name string
		var sn, en int
		if err := sc(&id, &sn, &en, &name); err != nil {
			return err
		}
		l := fmt.Sprintf("S%02dE%02d", sn, en)
		if name != "" {
			l += " · " + name
		}
		labels[id] = l
		return nil
	}, lang); err != nil {
		return nil, err
	}
	for _, it := range items {
		if p, ok := profs[it.profileID]; ok {
			ref := p.ref
			it.Profile = &ref
			it.userID = p.userID // the viewer is the profile's account
		} else {
			it.profileID = ""
		}
		if d, ok := devs[it.deviceID]; ok {
			it.Device = &DeviceRef{ID: it.deviceID, Name: d.name, Online: live.IsOnline(it.deviceID)}
			if it.userID == "" {
				it.userID = d.owner
			}
		}
		if it.EpisodeLabel == nil && it.episodeID != nil {
			if l, ok := labels[*it.episodeID]; ok {
				it.EpisodeLabel = &l
			}
		}
	}
	var userIDs []string
	for _, it := range items {
		if it.userID != "" {
			userIDs = append(userIDs, it.userID)
		}
	}
	users := map[string]UserRef{}
	if err := s.scanEach(ctx, `SELECT id, username, display_name FROM users WHERE id = ANY($1::uuid[])`, userIDs, func(sc func(...any) error) error {
		var u UserRef
		if err := sc(&u.ID, &u.Username, &u.DisplayName); err != nil {
			return err
		}
		users[u.ID] = u
		return nil
	}); err != nil {
		return nil, err
	}
	sums, err := s.catalog.SummariesByID(ctx, mediaIDs, lang)
	if err != nil {
		return nil, err
	}
	out := make([]ActivityItem, 0, len(items))
	for _, it := range items {
		m, okM := sums[it.mediaID]
		u, okU := users[it.userID]
		if !okM || !okU {
			continue
		}
		it.Media, it.User = m, u
		out = append(out, *it)
	}
	slices.SortStableFunc(out, func(a, b ActivityItem) int { return b.UpdatedAt.Compare(a.UpdatedAt) })
	return out, nil
}

// scanEach runs a query with ids as $1 (plus extra args) and calls fn per row.
func (s *Service) scanEach(ctx context.Context, sql string, ids []string, fn func(scan func(...any) error) error, extra ...any) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.pool.Query(ctx, sql, append([]any{ids}, extra...)...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := fn(rows.Scan); err != nil {
			return err
		}
	}
	return rows.Err()
}

// AdminHistory is GET /admin/users/{id}/history: every profile of the user.
func (s *Service) AdminHistory(ctx context.Context, userID, cursor string, limit int, lang string) ([]AdminHistoryItem, *string, error) {
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)`, userID).Scan(&exists); err != nil {
		return nil, nil, err
	}
	if !exists {
		return nil, nil, ErrNotFound
	}
	profRefs := map[string]ProfileRef{}
	var profIDs []string
	rows, err := s.pool.Query(ctx, `SELECT id, name, color FROM profiles WHERE user_id = $1`, userID)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var p ProfileRef
		if err := rows.Scan(&p.ID, &p.Name, &p.Color); err != nil {
			rows.Close()
			return nil, nil, err
		}
		profRefs[p.ID] = p
		profIDs = append(profIDs, p.ID)
	}
	rows.Close()
	if len(profIDs) == 0 {
		return []AdminHistoryItem{}, nil, nil
	}
	prog, next, err := s.historyRows(ctx, profIDs, cursor, limit)
	if err != nil {
		return nil, nil, err
	}
	var mediaIDs, devIDs []string
	for _, p := range prog {
		mediaIDs = append(mediaIDs, p.MediaID)
		if p.DeviceID != nil {
			devIDs = append(devIDs, *p.DeviceID)
		}
	}
	devNames := map[string]string{}
	if err := s.scanEach(ctx, `SELECT id, name FROM devices WHERE id = ANY($1::uuid[])`, devIDs, func(sc func(...any) error) error {
		var id, name string
		if err := sc(&id, &name); err != nil {
			return err
		}
		devNames[id] = name
		return nil
	}); err != nil {
		return nil, nil, err
	}
	sums, err := s.catalog.SummariesByID(ctx, mediaIDs, lang)
	if err != nil {
		return nil, nil, err
	}
	out := make([]AdminHistoryItem, 0, len(prog))
	for _, p := range prog {
		m, ok := sums[p.MediaID]
		if !ok {
			continue
		}
		it := AdminHistoryItem{HistoryItem: HistoryItem{Media: m, Progress: p}, Profile: profRefs[p.profileID]}
		if p.DeviceID != nil {
			if n, ok := devNames[*p.DeviceID]; ok {
				it.DeviceName = &n
			}
		}
		out = append(out, it)
	}
	return out, next, nil
}

// AdminRoutes mounts the admin views on the admin group (RequireAdmin).
func (h *Handlers) AdminRoutes(admin fiber.Router, live LiveStates) {
	// «Новые серии»: schedule + last checks, and «run now».
	admin.Get("/new-episodes", func(c fiber.Ctx) error {
		st, err := h.svc.NewEpisodesAdminStatus(c.Context())
		if err != nil {
			return err
		}
		return c.JSON(st)
	})
	admin.Post("/new-episodes/run", func(c fiber.Ctx) error {
		if err := h.svc.StartNewEpisodesCheck(); err != nil {
			if errors.Is(err, ErrCheckRunning) {
				return httpx.NewError(fiber.StatusConflict, "already_running", "A check is already running.")
			}
			return err
		}
		return c.SendStatus(fiber.StatusAccepted)
	})
	admin.Get("/activity/now", func(c fiber.Ctx) error {
		lang, err := langParam(c)
		if err != nil {
			return err
		}
		items, err := h.svc.Activity(c.Context(), live, lang)
		if err != nil {
			return err
		}
		return c.JSON(httpx.List(items))
	})
	admin.Get("/users/:id/history", func(c fiber.Ctx) error {
		uid, err := httpx.ParamUUID(c, "id")
		if err != nil {
			return err
		}
		lang, err := langParam(c)
		if err != nil {
			return err
		}
		limit, err := limitParam(c)
		if err != nil {
			return err
		}
		items, next, err := h.svc.AdminHistory(c.Context(), uid, c.Query("cursor"), limit, lang)
		if err != nil {
			return fail(err)
		}
		return c.JSON(fiber.Map{"items": items, "next_cursor": next})
	})
}
