package video

import (
	"context"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
	"martytv/api/internal/playback"
)

// profile reads ?profile_id (required=true: per-profile lists) and checks
// access (404 for someone else's profile).
func (s *Service) profile(c fiber.Ctx, required bool) (string, error) {
	id := strings.TrimSpace(c.Query("profile_id"))
	if id == "" {
		if required {
			return "", httpx.Validation(map[string]string{"profile_id": "Required."})
		}
		return "", nil
	}
	if u, err := uuid.Parse(id); err != nil || u.String() != id {
		return "", httpx.Validation(map[string]string{"profile_id": "Must be a UUID."})
	}
	ok, err := s.profiles.CanUse(c.Context(), auth.PrincipalFrom(c), id)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", httpx.NotFound()
	}
	return id, nil
}

func (s *Service) prefsFor(ctx context.Context, profileID string) Prefs {
	if profileID == "" || s.prefs == nil {
		return Prefs{Quality: DefaultQuality, HideShorts: DefaultHideShorts}
	}
	return s.prefs(ctx, profileID)
}

// annotate adds the profile's progress to items (in place).
func (s *Service) annotate(ctx context.Context, profileID string, items []Item) error {
	if profileID == "" || len(items) == 0 {
		return nil
	}
	ids := make([]string, len(items))
	for i, it := range items {
		ids[i] = it.ID
	}
	m, err := s.st.progressMap(ctx, profileID, ids)
	if err != nil {
		return err
	}
	for i := range items {
		items[i].Progress = m[items[i].ID]
	}
	return nil
}

// listOut filters Shorts by the profile setting and adds progress. The
// list's thumbnails are queued for prefetch.
func (s *Service) listOut(c fiber.Ctx, profileID string, items []Item) ([]Item, error) {
	items = s.client.Originals(items)
	items = filterShorts(items, s.prefsFor(c.Context(), profileID).HideShorts && c.Query("shorts") != "true")
	if err := s.annotate(c.Context(), profileID, items); err != nil {
		return nil, err
	}
	s.warmThumbs(items, false)
	return items, nil
}

func (s *Service) search(c fiber.Ctx) error {
	pid, err := s.profile(c, false)
	if err != nil {
		return err
	}
	q := strings.TrimSpace(c.Query("q"))
	fields := map[string]string{}
	if q == "" || utf8.RuneCountInString(q) > 150 {
		fields["q"] = "Required, at most 150 characters."
	}
	typ := c.Query("type", "all")
	switch typ {
	case "all", "video", "channel", "playlist":
	default:
		fields["type"] = "One of all, video, channel, playlist."
	}
	page, perr := strconv.Atoi(c.Query("page", "1"))
	if perr != nil || page < 1 || page > 20 {
		fields["page"] = "1…20."
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	raw, err := s.client.Search(c.Context(), q, typ, page, s.region)
	if err != nil {
		return apiErr(err)
	}
	out := SearchResult{Videos: []Item{}, Channels: []ChannelRef{}, Playlists: []PlaylistRef{}, Page: page}
	var vids []ivItem
	for _, it := range raw {
		switch it.Type {
		case "video", "shortVideo":
			vids = append(vids, it)
		case "channel":
			if ch, ok := toChannelRef(it); ok {
				if n, ok := s.client.OriginalChannelName(ch.ID); ok {
					ch.Name = n
				}
				out.Channels = append(out.Channels, ch)
			}
		case "playlist":
			if p, ok := toPlaylistRef(it); ok {
				out.Playlists = append(out.Playlists, p)
			}
		}
	}
	if out.Videos, err = s.listOut(c, pid, toItems(vids)); err != nil {
		return err
	}
	if pid != "" && len(out.Channels) > 0 {
		ids := make([]string, len(out.Channels))
		for i, ch := range out.Channels {
			ids[i] = ch.ID
		}
		subs, err := s.st.subscribedSet(c.Context(), pid, ids)
		if err != nil {
			return err
		}
		for i := range out.Channels {
			out.Channels[i].Subscribed = subs[out.Channels[i].ID]
		}
	}
	return c.JSON(out)
}

func (s *Service) suggestions(c fiber.Ctx) error {
	q := strings.TrimSpace(c.Query("q"))
	if q == "" || utf8.RuneCountInString(q) > 100 {
		return httpx.Validation(map[string]string{"q": "Required, at most 100 characters."})
	}
	sug, err := s.client.Suggestions(c.Context(), q)
	if err != nil {
		return apiErr(err)
	}
	if len(sug) > 10 {
		sug = sug[:10]
	}
	if sug == nil {
		sug = []string{}
	}
	return c.JSON(fiber.Map{"items": sug})
}

var trendingTypes = map[string]string{"": "", "default": "", "music": "music", "gaming": "gaming", "movies": "movies", "news": "news"}

func (s *Service) trending(c fiber.Ctx) error {
	pid, err := s.profile(c, false)
	if err != nil {
		return err
	}
	region := strings.ToUpper(strings.TrimSpace(c.Query("region", s.region)))
	if len(region) != 2 || region[0] < 'A' || region[0] > 'Z' || region[1] < 'A' || region[1] > 'Z' {
		return httpx.Validation(map[string]string{"region": "An ISO 3166-1 alpha-2 code."})
	}
	typ, ok := trendingTypes[c.Query("type")]
	if !ok {
		return httpx.Validation(map[string]string{"type": "One of default, music, gaming, movies, news."})
	}
	raw, err := s.client.Trending(c.Context(), region, typ)
	if err != nil {
		return apiErr(err)
	}
	items := toItems(raw)
	// YouTube retired its trending page; Invidious' default list is now
	// mostly live streams (which Cineko can't play yet). Keep the playable
	// ones and top up from the gaming chart, which still works.
	if typ == "" {
		items = withoutLive(items)
		if len(items) < 12 {
			if more, err := s.client.Trending(c.Context(), region, "gaming"); err == nil {
				items = mergeItems(items, withoutLive(toItems(more)))
			}
		}
	}
	items, err = s.listOut(c, pid, items)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"items": items})
}

func withoutLive(items []Item) []Item {
	out := items[:0:0]
	for _, it := range items {
		if !it.Live && !it.Upcoming {
			out = append(out, it)
		}
	}
	return out
}

func mergeItems(a, b []Item) []Item {
	seen := map[string]bool{}
	out := make([]Item, 0, len(a)+len(b))
	for _, l := range [][]Item{a, b} {
		for _, it := range l {
			if !seen[it.ID] {
				seen[it.ID] = true
				out = append(out, it)
			}
		}
	}
	return out
}

func (s *Service) videoDetail(c fiber.Ctx) error {
	pid, err := s.profile(c, false)
	if err != nil {
		return err
	}
	id := c.Params("id")
	if !ValidVideoID(id) {
		return httpx.NotFound()
	}
	v, err := s.client.Video(c.Context(), id, false)
	if err != nil {
		return apiErr(err)
	}
	d := s.toDetail(v)
	if pid != "" {
		ctx := c.Context()
		if d.Progress, err = s.st.progress(ctx, pid, id); err != nil {
			return err
		}
		if d.InWatchLater, err = s.st.inWatchLater(ctx, pid, id); err != nil {
			return err
		}
		if d.Channel.Subscribed, err = s.st.isSubscribed(ctx, pid, d.ChannelID); err != nil {
			return err
		}
		if d.Related, err = s.listOut(c, pid, d.Related); err != nil {
			return err
		}
	}
	s.warmThumbs(d.Related, true)
	return c.JSON(d)
}

func (s *Service) toDetail(v *ivVideo) Detail {
	it, _ := toItem(v.ivItem)
	if it.ID == "" { // /videos/{id} has no "type"
		it, _ = toItem(ivItem{VideoID: v.VideoID, Title: v.Title})
	}
	it.Live = v.LiveNow || (v.LengthSeconds == 0 && !v.IsUpcoming)
	d := Detail{Item: it, Description: v.DescriptionFull, Related: s.client.Originals(toItems(v.RecommendedVideo)), Captions: []Caption{}}
	if v.LikeCount > 0 {
		n := int64(v.LikeCount)
		d.Likes = &n
	}
	if v.Genre != "" {
		g := v.Genre
		d.Genre = &g
	}
	d.Channel = ChannelRef{ID: v.AuthorID, Name: v.Author, Avatar: avatarURL(v.AuthorThumbnails, 176), Verified: v.AuthorVerified}
	if n, ok := parseCount(v.SubCountText); ok && n > 0 {
		d.Channel.Subscribers = &n
	}
	st := s.toStreams(v)
	d.Qualities = []int{}
	seen := map[int]bool{}
	for _, l := range [][]int{heights(st.Video, len(st.Audio) > 0), heights(st.Progressive, true)} {
		for _, h := range l {
			if !seen[h] && h <= 1080 {
				seen[h] = true
				d.Qualities = append(d.Qualities, h)
			}
		}
	}
	sortDesc(d.Qualities)
	d.Playable = !st.Live && len(d.Qualities) > 0
	for _, cc := range st.Captions {
		d.Captions = append(d.Captions, Caption{Label: cc.Label, Language: cc.Language})
	}
	return d
}

func sortDesc(a []int) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] > a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}

func (s *Service) channel(c fiber.Ctx) error {
	pid, err := s.profile(c, false)
	if err != nil {
		return err
	}
	id := c.Params("id")
	if !ValidChannelID(id) {
		return httpx.NotFound()
	}
	ch, err := s.client.Channel(c.Context(), id)
	if err != nil {
		return apiErr(err)
	}
	vids, err := s.client.ChannelVideos(c.Context(), id, "")
	if err != nil {
		return apiErr(err)
	}
	s.channelOriginals(c.Context(), id)
	out := Channel{ChannelRef: ChannelRef{ID: ch.AuthorID, Name: ch.Author, Avatar: avatarURL(ch.AuthorThumbnails, 176), Verified: ch.AuthorVerified},
		Description: ch.Description}
	if out.ID == "" {
		out.ID = id
	}
	if n, ok := s.client.OriginalChannelName(out.ID); ok {
		out.Name = n
	}
	if ch.SubCount > 0 {
		n := int64(ch.SubCount)
		out.Subscribers = &n
	}
	if len(ch.AuthorBanners) > 0 {
		out.Banner = ggphtURL(ch.AuthorBanners[0].URL, "w1280")
	}
	if vids.Continuation != "" {
		cont := vids.Continuation
		out.Continuation = &cont
	}
	if out.Videos, err = s.listOut(c, pid, toItems(vids.Videos)); err != nil {
		return err
	}
	if pid != "" {
		if out.Subscribed, err = s.st.isSubscribed(c.Context(), pid, out.ID); err != nil {
			return err
		}
	}
	return c.JSON(out)
}

func (s *Service) channelVideos(c fiber.Ctx) error {
	pid, err := s.profile(c, false)
	if err != nil {
		return err
	}
	id := c.Params("id")
	if !ValidChannelID(id) {
		return httpx.NotFound()
	}
	cont := c.Query("continuation")
	if len(cont) > 2000 {
		return httpx.Validation(map[string]string{"continuation": "Too long."})
	}
	vids, err := s.client.ChannelVideos(c.Context(), id, cont)
	if err != nil {
		return apiErr(err)
	}
	s.channelOriginals(c.Context(), id)
	out := Page{}
	if vids.Continuation != "" {
		n := vids.Continuation
		out.Continuation = &n
	}
	if out.Items, err = s.listOut(c, pid, toItems(vids.Videos)); err != nil {
		return err
	}
	return c.JSON(out)
}

func (s *Service) playlist(c fiber.Ctx) error {
	pid, err := s.profile(c, false)
	if err != nil {
		return err
	}
	id := c.Params("id")
	if !playlistIDRe.MatchString(id) {
		return httpx.NotFound()
	}
	p, err := s.client.Playlist(c.Context(), id)
	if err != nil {
		return apiErr(err)
	}
	ref, _ := toPlaylistRef(ivItem{PlaylistID: id, Title: p.Title, Author: p.Author, AuthorID: p.AuthorID,
		VideoCount: p.VideoCount, PlaylistThumbnail: p.Thumbnail})
	out := Playlist{PlaylistRef: ref, Description: p.Description}
	items := s.client.Originals(toItems(p.Videos))
	if err := s.annotate(c.Context(), pid, items); err != nil {
		return err
	}
	out.Videos = items
	s.warmThumbs(items, false)
	return c.JSON(out)
}

// ---- per profile ----

func (s *Service) feed(c fiber.Ctx) error {
	pid, err := s.profile(c, true)
	if err != nil {
		return err
	}
	offset, limit, err := feedPage(c)
	if err != nil {
		return err
	}
	items, at, err := s.st.feed(c.Context(), pid, offset, limit)
	if err != nil {
		return err
	}
	// A full page means there may be more (Shorts are dropped after paging,
	// so the next offset counts feed entries, not returned items).
	var next *int
	if len(items) == limit {
		n := offset + limit
		next = &n
	}
	items, err = s.listOut(c, pid, items)
	if err != nil {
		return err
	}
	var refreshed *string
	if at != nil {
		refreshed = ts(*at)
	}
	return c.JSON(fiber.Map{"items": items, "refreshed_at": refreshed, "next_offset": next})
}

// feedPage reads ?offset (0…5000, default 0) and ?limit (1…200, default 100).
func feedPage(c fiber.Ctx) (offset, limit int, err error) {
	fields := map[string]string{}
	offset, limit = 0, 100
	if v := c.Query("offset"); v != "" {
		if n, e := strconv.Atoi(v); e != nil || n < 0 || n > 5000 {
			fields["offset"] = "0…5000."
		} else {
			offset = n
		}
	}
	if v := c.Query("limit"); v != "" {
		if n, e := strconv.Atoi(v); e != nil || n < 1 || n > 200 {
			fields["limit"] = "1…200."
		} else {
			limit = n
		}
	}
	if len(fields) > 0 {
		return 0, 0, httpx.Validation(fields)
	}
	return offset, limit, nil
}

// channelOriginals loads a channel's RSS feed (cached) so Originals knows
// its original titles and name. Best effort: a failure changes nothing.
func (s *Service) channelOriginals(ctx context.Context, id string) {
	cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	_, _ = s.client.ChannelFeed(cctx, id)
}

func (s *Service) listSubscriptions(c fiber.Ctx) error {
	pid, err := s.profile(c, true)
	if err != nil {
		return err
	}
	subs, err := s.st.subscriptions(c.Context(), pid)
	if err != nil {
		return err
	}
	return c.JSON(httpx.List(subs))
}

func (s *Service) subscribe(c fiber.Ctx) error {
	pid, err := s.profile(c, true)
	if err != nil {
		return err
	}
	id := c.Params("channel_id")
	if !ValidChannelID(id) {
		return httpx.Validation(map[string]string{"channel_id": "A YouTube channel id (UC…)."})
	}
	ref := ChannelRef{ID: id, Subscribed: true}
	// Name and avatar for the list; the subscription works without them
	// (the feed refresh fills the name in).
	if ch, err := s.client.Channel(c.Context(), id); err == nil {
		ref.Name, ref.Avatar, ref.Verified = ch.Author, avatarURL(ch.AuthorThumbnails, 176), ch.AuthorVerified
		s.channelOriginals(c.Context(), id)
		if n, ok := s.client.OriginalChannelName(id); ok {
			ref.Name = n
		}
		if ch.SubCount > 0 {
			n := int64(ch.SubCount)
			ref.Subscribers = &n
		}
	} else if isNotFound(err) {
		return httpx.NotFound()
	}
	if _, err := s.st.subscribe(c.Context(), pid, ref); err != nil {
		return err
	}
	if at, _ := s.st.channelRefreshedAt(c.Context(), id); time.Since(at) > feedRefreshEvery {
		s.kickChannel(id)
	}
	return c.JSON(ref)
}

func isNotFound(err error) bool { return errors.Is(err, ErrNotFound) }

func (s *Service) unsubscribe(c fiber.Ctx) error {
	pid, err := s.profile(c, true)
	if err != nil {
		return err
	}
	id := c.Params("channel_id")
	if !ValidChannelID(id) {
		return httpx.NotFound()
	}
	if _, err := s.st.unsubscribe(c.Context(), pid, id); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Service) listWatchLater(c fiber.Ctx) error {
	pid, err := s.profile(c, true)
	if err != nil {
		return err
	}
	items, err := s.st.watchLater(c.Context(), pid)
	if err != nil {
		return err
	}
	if err := s.annotate(c.Context(), pid, items); err != nil {
		return err
	}
	s.warmThumbs(items, false)
	return c.JSON(httpx.List(items))
}

// itemFor builds the snapshot of a video for lists (Invidious, cached).
func (s *Service) itemFor(ctx context.Context, pid, id string) (*Item, error) {
	v, err := s.client.Video(ctx, id, false)
	if err != nil {
		// Already in history: reuse its snapshot.
		if it, _ := s.st.progressItem(ctx, pid, id); it != nil {
			return it, nil
		}
		return nil, apiErr(err)
	}
	d := s.toDetail(v)
	return &d.Item, nil
}

func (s *Service) addWatchLater(c fiber.Ctx) error {
	pid, err := s.profile(c, true)
	if err != nil {
		return err
	}
	id := c.Params("video_id")
	if !ValidVideoID(id) {
		return httpx.Validation(map[string]string{"video_id": "An 11-character YouTube video id."})
	}
	it, err := s.itemFor(c.Context(), pid, id)
	if err != nil {
		return err
	}
	if err := s.st.addWatchLater(c.Context(), pid, *it); err != nil {
		return err
	}
	return c.JSON(it)
}

func (s *Service) removeWatchLater(c fiber.Ctx) error {
	pid, err := s.profile(c, true)
	if err != nil {
		return err
	}
	id := c.Params("video_id")
	if !ValidVideoID(id) {
		return httpx.NotFound()
	}
	if _, err := s.st.removeWatchLater(c.Context(), pid, id); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Service) listHistory(c fiber.Ctx) error {
	pid, err := s.profile(c, true)
	if err != nil {
		return err
	}
	items, err := s.st.history(c.Context(), pid, false, 200)
	if err != nil {
		return err
	}
	s.warmThumbs(items, false)
	return c.JSON(httpx.List(items))
}

func (s *Service) listContinue(c fiber.Ctx) error {
	pid, err := s.profile(c, true)
	if err != nil {
		return err
	}
	items, err := s.st.history(c.Context(), pid, true, 30)
	if err != nil {
		return err
	}
	s.warmThumbs(items, false)
	return c.JSON(httpx.List(items))
}

func (s *Service) removeHistory(c fiber.Ctx) error {
	pid, err := s.profile(c, true)
	if err != nil {
		return err
	}
	id := c.Params("video_id")
	if !ValidVideoID(id) {
		return httpx.NotFound()
	}
	if _, err := s.st.removeHistory(c.Context(), pid, id); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// finished: within the last 8 % or 20 s.
func isFinished(pos, dur float64) bool {
	return dur > 0 && (pos >= dur*0.92 || dur-pos <= 20)
}

func (s *Service) postProgress(c fiber.Ctx) error {
	var in struct {
		ProfileID       string   `json:"profile_id"`
		VideoID         string   `json:"video_id"`
		PositionSeconds *float64 `json:"position_seconds"`
		DurationSeconds *float64 `json:"duration_seconds"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	fields := map[string]string{}
	if !ValidVideoID(in.VideoID) {
		fields["video_id"] = "An 11-character YouTube video id."
	}
	okNum := func(f *float64) bool { return f != nil && *f >= 0 && *f < 1e7 && !math.IsNaN(*f) && !math.IsInf(*f, 0) }
	if !okNum(in.PositionSeconds) {
		fields["position_seconds"] = "Required, ≥ 0."
	}
	if in.DurationSeconds != nil && !okNum(in.DurationSeconds) {
		fields["duration_seconds"] = "≥ 0."
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	c.Request().URI().QueryArgs().Set("profile_id", in.ProfileID)
	pid, err := s.profile(c, true)
	if err != nil {
		return err
	}
	ctx := c.Context()
	it, err := s.st.progressItem(ctx, pid, in.VideoID)
	if err != nil {
		return err
	}
	if it == nil {
		if it, err = s.itemFor(ctx, pid, in.VideoID); err != nil {
			return err
		}
	}
	dur := 0.0
	if in.DurationSeconds != nil {
		dur = *in.DurationSeconds
	}
	if dur == 0 && it.DurationSeconds != nil {
		dur = float64(*it.DurationSeconds)
	}
	pos := *in.PositionSeconds
	if dur > 0 && pos > dur {
		pos = dur
	}
	if err := s.st.saveProgress(ctx, pid, *it, pos, dur, isFinished(pos, dur)); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// heights of tracks (none when ok is false: video without audio is unplayable).
func heights(ts []playback.VideoTrack, ok bool) []int {
	if !ok {
		return nil
	}
	out := make([]int, 0, len(ts))
	for _, t := range ts {
		if t.Height > 0 {
			out = append(out, t.Height)
		}
	}
	return out
}
