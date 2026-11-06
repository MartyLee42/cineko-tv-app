package iptv

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Programme is an EPG entry (contract: IptvProgramme).
type Programme struct {
	Start       time.Time `json:"start"`
	Stop        time.Time `json:"stop"`
	Title       string    `json:"title"`
	Description *string   `json:"description"`
	Category    *string   `json:"category"`
}

// Channel is a listed channel (contract: IptvChannel).
type Channel struct {
	ID           string     `json:"id"`
	Number       int        `json:"number"`
	CustomNumber *int       `json:"custom_number"`
	Name         string     `json:"name"`
	LogoURL      *string    `json:"logo_url"`
	GroupID      string     `json:"group_id"`
	Group        string     `json:"group"`
	PlaylistID   string     `json:"playlist_id"`
	Favorite     bool       `json:"favorite"`
	Hidden       bool       `json:"hidden"`
	Offline      bool       `json:"offline"`
	Format       *string    `json:"format"`
	HasEPG       bool       `json:"has_epg"`
	Now          *Programme `json:"now"`
	Next         *Programme `json:"next"`

	epgSource, epgChannel string
	altNames              []string
}

// Group is a channel group (contract: IptvGroup).
type Group struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type listOpts struct {
	Group         string
	Query         string
	IncludeHidden bool
}

// lineup is the profile's channel list before the group/q filters.
type lineup struct {
	all       []*Channel // visible (hidden ones only with IncludeHidden)
	groups    []Group
	favorites int
}

// selection returns the playlist ids a profile shows (nil = all).
func (s *Service) selection(ctx context.Context, profileID *string) ([]string, error) {
	if profileID == nil || s.profiles == nil {
		return nil, nil
	}
	st, err := s.profiles.GetSettings(ctx, *profileID)
	if err != nil {
		return nil, err
	}
	if st.IPTVPlaylists == nil || st.IPTVPlaylists.All {
		return nil, nil
	}
	ids := st.IPTVPlaylists.IDs
	if ids == nil {
		ids = []string{}
	}
	return ids, nil
}

// lineup builds the profile's numbered channel list: deduplicated across
// playlists (first playlist wins), custom order first, custom numbers
// claimed before sequential ones.
func (s *Service) lineup(ctx context.Context, profileID *string, includeHidden bool) (*lineup, error) {
	sel, err := s.selection(ctx, profileID)
	if err != nil {
		return nil, err
	}
	rows, err := s.st.channels(ctx, profileID, sel)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	uniq := rows[:0]
	for _, r := range rows {
		if seen[r.Key] {
			continue
		}
		seen[r.Key] = true
		uniq = append(uniq, r)
	}
	// Custom order: positioned channels first (by position), then the rest.
	sort.SliceStable(uniq, func(i, j int) bool {
		a, b := uniq[i].Pos, uniq[j].Pos
		switch {
		case a != nil && b != nil:
			return *a < *b
		case a != nil:
			return true
		default:
			return false
		}
	})
	claimed := map[int]bool{}
	for _, r := range uniq {
		if r.Number != nil {
			claimed[*r.Number] = true
		}
	}
	used := map[int]bool{}
	next := 1
	out := &lineup{}
	groupIdx := map[string]int{}
	for _, r := range uniq {
		var num int
		if r.Number != nil && !used[*r.Number] {
			num = *r.Number
		} else {
			for claimed[next] || used[next] {
				next++
			}
			num = next
			next++
		}
		used[num] = true
		if r.Hidden && !includeHidden {
			continue
		}
		title := ""
		if r.Group != nil {
			title = *r.Group
		}
		c := &Channel{ID: r.ID, Number: num, CustomNumber: r.Number, Name: r.Name, GroupID: GroupID(title), Group: groupName(title),
			PlaylistID: r.PlaylistID, Favorite: r.Favorite, Hidden: r.Hidden, Offline: r.Offline, Format: r.Format,
			HasEPG: r.EPGChannel != nil, altNames: r.AltNames}
		if r.Logo != nil && *r.Logo != "" && !s.logoFailed(*r.Logo) {
			u := "/api/v1/iptv/logos/" + r.ID + "?v=" + hash8(*r.Logo)
			c.LogoURL = &u
		}
		if r.EPGSource != nil && r.EPGChannel != nil {
			c.epgSource, c.epgChannel = *r.EPGSource, *r.EPGChannel
		}
		out.all = append(out.all, c)
		if c.Favorite {
			out.favorites++
		}
		if i, ok := groupIdx[c.GroupID]; ok {
			out.groups[i].Count++
		} else {
			groupIdx[c.GroupID] = len(out.groups)
			out.groups = append(out.groups, Group{ID: c.GroupID, Name: c.Group, Count: 1})
		}
	}
	sort.SliceStable(out.all, func(i, j int) bool { return out.all[i].Number < out.all[j].Number })
	return out, nil
}

// filter applies the group and search filters.
func (l *lineup) filter(o listOpts) []*Channel {
	q := strings.TrimSpace(o.Query)
	num, numErr := strconv.Atoi(q)
	nq := NormalizeName(q)
	lq := strings.ReplaceAll(strings.ToLower(q), "ё", "е")
	out := []*Channel{}
	for _, c := range l.all {
		switch {
		case o.Group == "" || o.Group == "all":
		case o.Group == "favorites":
			if !c.Favorite {
				continue
			}
		case c.GroupID != o.Group:
			continue
		}
		if q != "" {
			ok := false
			if numErr == nil && num == c.Number {
				ok = true
			}
			if !ok && strings.Contains(strings.ReplaceAll(strings.ToLower(c.Name), "ё", "е"), lq) {
				ok = true
			}
			if !ok && nq != "" {
				for _, n := range append([]string{c.Name}, c.altNames...) {
					if strings.Contains(NormalizeName(n), nq) {
						ok = true
						break
					}
				}
			}
			if !ok {
				continue
			}
		}
		out = append(out, c)
	}
	return out
}

// fillNowNext sets now/next on channels with a guide.
func (s *Service) fillNowNext(ctx context.Context, chs []*Channel) error {
	var srcs, xs []string
	for _, c := range chs {
		if c.epgChannel != "" {
			srcs, xs = append(srcs, c.epgSource), append(xs, c.epgChannel)
		}
	}
	now := s.now()
	rows, err := s.st.nowNext(ctx, srcs, xs, now)
	if err != nil {
		return err
	}
	by := map[string][]progRow{}
	for _, r := range rows {
		k := r.Source + "\x00" + r.Channel
		by[k] = append(by[k], r)
	}
	for _, c := range chs {
		ps := by[c.epgSource+"\x00"+c.epgChannel]
		if len(ps) == 0 {
			continue
		}
		if !ps[0].Start.After(now) {
			c.Now = programme(ps[0], 300)
			if len(ps) > 1 {
				c.Next = programme(ps[1], 0)
			}
		} else {
			c.Next = programme(ps[0], 0)
		}
	}
	return nil
}

// programme converts a row; descLen 0 drops the description.
func programme(r progRow, descLen int) *Programme {
	p := &Programme{Start: r.Start.UTC(), Stop: r.Stop.UTC(), Title: r.Title, Category: r.Category}
	if descLen > 0 && r.Desc != nil {
		d := clip(*r.Desc, descLen)
		p.Description = &d
	}
	return p
}

// schedules returns programmes in [from, to) per channel id.
func (s *Service) schedules(ctx context.Context, chs []*Channel, from, to time.Time, descLen int) (map[string][]Programme, error) {
	var srcs, xs []string
	for _, c := range chs {
		if c.epgChannel != "" {
			srcs, xs = append(srcs, c.epgSource), append(xs, c.epgChannel)
		}
	}
	rows, err := s.st.programmes(ctx, srcs, xs, from, to)
	if err != nil {
		return nil, err
	}
	by := map[string][]Programme{}
	for _, r := range rows {
		k := r.Source + "\x00" + r.Channel
		by[k] = append(by[k], *programme(r, descLen))
	}
	out := map[string][]Programme{}
	for _, c := range chs {
		ps := by[c.epgSource+"\x00"+c.epgChannel]
		if ps == nil {
			ps = []Programme{}
		}
		out[c.ID] = ps
	}
	return out, nil
}

// channelFor returns one channel as the profile sees it (hidden included).
func (s *Service) channelFor(ctx context.Context, profileID *string, id string) (*Channel, error) {
	l, err := s.lineup(ctx, profileID, true)
	if err != nil {
		return nil, err
	}
	for _, c := range l.all {
		if c.ID == id {
			if err := s.fillNowNext(ctx, []*Channel{c}); err != nil {
				return nil, err
			}
			return c, nil
		}
	}
	return nil, errNotFound
}

// ---------------------------------------------------------------- prefs

type prefsPatch struct {
	Favorite  *bool
	Hidden    *bool
	SetNumber bool
	Number    *int
}

func (s *Service) setPrefs(ctx context.Context, profileID, channelID string, p prefsPatch) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO iptv_profile_channels (profile_id, channel_id, favorite, hidden, number)
		VALUES ($1, $2, COALESCE($3, false), COALESCE($4, false), CASE WHEN $5 THEN $6::int END)
		ON CONFLICT (profile_id, channel_id) DO UPDATE SET
			favorite = COALESCE($3, iptv_profile_channels.favorite),
			hidden = COALESCE($4, iptv_profile_channels.hidden),
			number = CASE WHEN $5 THEN $6::int ELSE iptv_profile_channels.number END,
			updated_at = now()`, profileID, channelID, p.Favorite, p.Hidden, p.SetNumber, p.Number)
	return err
}

func (s *Service) setOrder(ctx context.Context, profileID string, ids []string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `UPDATE iptv_profile_channels SET position = NULL, updated_at = now() WHERE profile_id = $1 AND position IS NOT NULL`, profileID); err != nil {
		return err
	}
	if len(ids) > 0 {
		pos := make([]int32, len(ids))
		for i := range ids {
			pos[i] = int32(i)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO iptv_profile_channels (profile_id, channel_id, position)
			SELECT $1, k.id, k.pos FROM unnest($2::uuid[], $3::int[]) AS k(id, pos)
			JOIN iptv_channels c ON c.id = k.id
			ON CONFLICT (profile_id, channel_id) DO UPDATE SET position = EXCLUDED.position, updated_at = now()`,
			profileID, ids, pos); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Service) setWatched(ctx context.Context, profileID, channelID string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO iptv_profile_state (profile_id, last_channel_id, last_watched_at) VALUES ($1, $2, now())
		ON CONFLICT (profile_id) DO UPDATE SET last_channel_id = EXCLUDED.last_channel_id, last_watched_at = now()`,
		profileID, channelID)
	return err
}

func (s *Service) lastWatched(ctx context.Context, profileID string) (string, time.Time, error) {
	var id *string
	var at *time.Time
	err := s.pool.QueryRow(ctx, `SELECT last_channel_id::text, last_watched_at FROM iptv_profile_state WHERE profile_id = $1`, profileID).Scan(&id, &at)
	if err != nil || id == nil || at == nil {
		return "", time.Time{}, nil //nolint:nilerr // no row = nothing watched
	}
	return *id, *at, nil
}

// channelExists reports whether an active channel exists.
func (s *Service) channelExists(ctx context.Context, id string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM iptv_channels WHERE id = $1 AND active)`, id).Scan(&ok)
	return ok, err
}
