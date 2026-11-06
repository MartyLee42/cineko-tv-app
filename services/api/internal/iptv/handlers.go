package iptv

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
)

// Routes mounts /iptv/* (browser sessions, TVs, API tokens read/write;
// profile access through profiles.CanUse) and the public logo proxy.
// Per-route middleware: a Group on /iptv would also be fine, but the logo
// route must stay public.
func (s *Service) Routes(r fiber.Router) {
	pc := profiles.RequireProfileCaller()
	r.Get("/iptv/logos/:id", s.logo)
	r.Get("/iptv/channels", pc, s.listChannels)
	r.Get("/iptv/channels/:id/epg", pc, s.channelEPG)
	r.Patch("/iptv/channels/:id/prefs", pc, s.patchPrefs)
	r.Put("/iptv/order", pc, s.putOrder)
	r.Post("/iptv/watched", pc, s.postWatched)
	r.Get("/iptv/state", pc, s.getState)
	r.Get("/iptv/guide", pc, s.getGuide)
}

func validUUID(s string) bool {
	u, err := uuid.Parse(s)
	return err == nil && u.String() == s
}

// profileParam reads an optional ?profile_id and checks access (404).
func (s *Service) profileParam(c fiber.Ctx) (*string, error) {
	id := strings.TrimSpace(c.Query("profile_id"))
	if id == "" {
		return nil, nil
	}
	return s.checkProfile(c, id)
}

func (s *Service) checkProfile(c fiber.Ctx, id string) (*string, error) {
	if !validUUID(id) {
		return nil, httpx.Validation(map[string]string{"profile_id": "Must be a UUID."})
	}
	ok, err := s.profiles.CanUse(c.Context(), auth.PrincipalFrom(c), id)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, httpx.NotFound()
	}
	return &id, nil
}

type channelList struct {
	Items          []*Channel `json:"items"`
	Groups         []Group    `json:"groups"`
	FavoritesCount int        `json:"favorites_count"`
	LastChannelID  *string    `json:"last_channel_id"`
	ServerTime     time.Time  `json:"server_time"`
}

func (s *Service) listChannels(c fiber.Ctx) error {
	pid, err := s.profileParam(c)
	if err != nil {
		return err
	}
	opts := listOpts{Group: clip(c.Query("group"), 80), Query: clip(c.Query("q"), 100), IncludeHidden: c.Query("include_hidden") == "true"}
	l, err := s.lineup(c.Context(), pid, opts.IncludeHidden)
	if err != nil {
		return err
	}
	items := l.filter(opts)
	if err := s.fillNowNext(c.Context(), items); err != nil {
		return err
	}
	out := channelList{Items: items, Groups: l.groups, FavoritesCount: l.favorites, ServerTime: s.now().UTC()}
	if out.Groups == nil {
		out.Groups = []Group{}
	}
	if pid != nil {
		if id, _, _ := s.lastWatched(c.Context(), *pid); id != "" {
			out.LastChannelID = &id
		}
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(out)
}

// timeRange parses ?from&to with defaults and a maximum span.
func timeRange(c fiber.Ctx, defFrom, defTo time.Time, maxSpan time.Duration) (time.Time, time.Time, error) {
	from, to := defFrom, defTo
	if v := c.Query("from"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			return from, to, httpx.Validation(map[string]string{"from": "Must be an RFC 3339 date-time."})
		}
		from = t
		if c.Query("to") == "" {
			to = from.Add(defTo.Sub(defFrom))
		}
	}
	if v := c.Query("to"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			return from, to, httpx.Validation(map[string]string{"to": "Must be an RFC 3339 date-time."})
		}
		to = t
	}
	if !to.After(from) || to.Sub(from) > maxSpan {
		return from, to, httpx.Validation(map[string]string{"to": "Must be after from, at most " + maxSpan.String() + " later."})
	}
	return from.UTC(), to.UTC(), nil
}

func (s *Service) channelEPG(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	now := s.now()
	from, to, err := timeRange(c, now.Add(-3*time.Hour), now.Add(24*time.Hour), 72*time.Hour)
	if err != nil {
		return err
	}
	var src, ch *string
	err = s.pool.QueryRow(c.Context(), `SELECT epg_source, epg_channel FROM iptv_channels WHERE id = $1 AND active`, id).Scan(&src, &ch)
	if err != nil {
		return httpx.NotFound()
	}
	items := []Programme{}
	if src != nil && ch != nil {
		m, err := s.schedules(c.Context(), []*Channel{{ID: id, epgSource: *src, epgChannel: *ch}}, from, to, 1000)
		if err != nil {
			return err
		}
		items = m[id]
	}
	return c.JSON(fiber.Map{"items": items})
}

func (s *Service) patchPrefs(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	var in struct {
		ProfileID string          `json:"profile_id"`
		Favorite  *bool           `json:"favorite"`
		Hidden    *bool           `json:"hidden"`
		Number    json.RawMessage `json:"number"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	pid, err := s.checkProfile(c, in.ProfileID)
	if err != nil {
		return err
	}
	p := prefsPatch{Favorite: in.Favorite, Hidden: in.Hidden}
	if len(in.Number) > 0 {
		p.SetNumber = true
		if string(in.Number) != "null" {
			var n int
			if json.Unmarshal(in.Number, &n) != nil || n < 1 || n > 9999 {
				return httpx.Validation(map[string]string{"number": "1…9999 or null."})
			}
			p.Number = &n
		}
	}
	if ok, err := s.channelExists(c.Context(), id); err != nil {
		return err
	} else if !ok {
		return httpx.NotFound()
	}
	if err := s.setPrefs(c.Context(), *pid, id, p); err != nil {
		return err
	}
	ch, err := s.channelFor(c.Context(), pid, id)
	if errors.Is(err, errNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	return c.JSON(ch)
}

func (s *Service) putOrder(c fiber.Ctx) error {
	var in struct {
		ProfileID  string   `json:"profile_id"`
		ChannelIDs []string `json:"channel_ids"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	pid, err := s.checkProfile(c, in.ProfileID)
	if err != nil {
		return err
	}
	if in.ChannelIDs == nil || len(in.ChannelIDs) > 5000 {
		return httpx.Validation(map[string]string{"channel_ids": "Required, at most 5000 ids."})
	}
	seen := map[string]bool{}
	ids := make([]string, 0, len(in.ChannelIDs))
	for _, id := range in.ChannelIDs {
		if !validUUID(id) {
			return httpx.Validation(map[string]string{"channel_ids": "Must be UUIDs."})
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if err := s.setOrder(c.Context(), *pid, ids); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Service) postWatched(c fiber.Ctx) error {
	var in struct {
		ProfileID string `json:"profile_id"`
		ChannelID string `json:"channel_id"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	pid, err := s.checkProfile(c, in.ProfileID)
	if err != nil {
		return err
	}
	if !validUUID(in.ChannelID) {
		return httpx.Validation(map[string]string{"channel_id": "Must be a UUID."})
	}
	if ok, err := s.channelExists(c.Context(), in.ChannelID); err != nil {
		return err
	} else if !ok {
		return httpx.NotFound()
	}
	if err := s.setWatched(c.Context(), *pid, in.ChannelID); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

type statePlaylist struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ChannelCount int    `json:"channel_count"`
	Selected     bool   `json:"selected"`
}

type lastState struct {
	Channel   *Channel  `json:"channel"`
	WatchedAt time.Time `json:"watched_at"`
}

func (s *Service) getState(c fiber.Ctx) error {
	pid, err := s.profileParam(c)
	if err != nil {
		return err
	}
	ctx := c.Context()
	l, err := s.lineup(ctx, pid, false)
	if err != nil {
		return err
	}
	out := struct {
		Available    bool            `json:"available"`
		ChannelCount int             `json:"channel_count"`
		Last         *lastState      `json:"last"`
		Playlists    []statePlaylist `json:"playlists"`
	}{Available: len(l.all) > 0, ChannelCount: len(l.all), Playlists: []statePlaylist{}}
	if pid != nil {
		if id, at, _ := s.lastWatched(ctx, *pid); id != "" {
			if ch, err := s.channelFor(ctx, pid, id); err == nil {
				out.Last = &lastState{Channel: ch, WatchedAt: at.UTC()}
			}
		}
	}
	sel, err := s.selection(ctx, pid)
	if err != nil {
		return err
	}
	pls, err := s.st.playlists(ctx, true)
	if err != nil {
		return err
	}
	st, err := s.st.stats(ctx)
	if err != nil {
		return err
	}
	for _, p := range pls {
		selected := sel == nil
		for _, id := range sel {
			if id == p.ID {
				selected = true
			}
		}
		out.Playlists = append(out.Playlists, statePlaylist{ID: p.ID, Name: p.Name, ChannelCount: st[p.ID].Channels, Selected: selected})
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(out)
}

type guideRow struct {
	Channel    *Channel    `json:"channel"`
	Programmes []Programme `json:"programmes"`
}

func (s *Service) getGuide(c fiber.Ctx) error {
	pid, err := s.profileParam(c)
	if err != nil {
		return err
	}
	now := s.now().UTC()
	defFrom := now.Add(-30 * time.Minute).Truncate(30 * time.Minute)
	from, to, err := timeRange(c, defFrom, defFrom.Add(4*time.Hour), 24*time.Hour)
	if err != nil {
		return err
	}
	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	limit, _ := strconv.Atoi(c.Query("limit", "30"))
	if offset < 0 || limit < 1 || limit > 100 {
		return httpx.Validation(map[string]string{"limit": "offset ≥ 0, limit 1…100."})
	}
	l, err := s.lineup(c.Context(), pid, false)
	if err != nil {
		return err
	}
	all := l.filter(listOpts{Group: clip(c.Query("group"), 80)})
	page := []*Channel{}
	if offset < len(all) {
		end := offset + limit
		if end > len(all) {
			end = len(all)
		}
		page = all[offset:end]
	}
	if err := s.fillNowNext(c.Context(), page); err != nil {
		return err
	}
	sched, err := s.schedules(c.Context(), page, from, to, 0)
	if err != nil {
		return err
	}
	items := make([]guideRow, 0, len(page))
	for _, ch := range page {
		items = append(items, guideRow{Channel: ch, Programmes: sched[ch.ID]})
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(fiber.Map{"from": from, "to": to, "total": len(all), "offset": offset, "items": items})
}
