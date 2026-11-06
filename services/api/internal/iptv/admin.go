package iptv

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
)

// MaxUploadBytes caps an uploaded M3U (PUT …/content).
const MaxUploadBytes = 5 << 20

// AdminRoutes mounts /admin/iptv/* on the admin group.
func (s *Service) AdminRoutes(admin fiber.Router) {
	admin.Get("/iptv/playlists", s.adminList)
	admin.Post("/iptv/playlists", s.adminCreate)
	admin.Patch("/iptv/playlists/:id", s.adminUpdate)
	admin.Delete("/iptv/playlists/:id", s.adminDelete)
	admin.Put("/iptv/playlists/:id/content", s.adminUpload)
	admin.Post("/iptv/playlists/:id/refresh", s.adminRefresh)
	admin.Get("/iptv/countries", func(c fiber.Ctx) error {
		out := make([]Country, 0, len(Countries))
		for _, cn := range Countries {
			cn, _ = countryByCode(cn.Code)
			if s.cfg.OrgEPGURL != "" {
				cn.Guides = s.templateGuides(cn.Code)
			}
			out = append(out, cn)
		}
		return c.JSON(httpx.List(out))
	})
}

type refreshInfo struct {
	Status      string     `json:"status"`
	Error       *string    `json:"error"`
	RefreshedAt *time.Time `json:"refreshed_at"`
	FetchedVia  *string    `json:"fetched_via"`
}

type epgInfo struct {
	Status        string     `json:"status"`
	Error         *string    `json:"error"`
	RefreshedAt   *time.Time `json:"refreshed_at"`
	XMLTVChannels int        `json:"xmltv_channels"`
	Programmes    int        `json:"programmes"`
	// Guides are the playlist's XMLTV guides in merge priority (first match wins).
	Guides []*GuideState `json:"guides"`
}

// AdminPlaylist is the contract's AdminIptvPlaylist.
type AdminPlaylist struct {
	ID              string      `json:"id"`
	Kind            string      `json:"kind"`
	Name            string      `json:"name"`
	URL             *string     `json:"url"`
	Country         *string     `json:"country"`
	EPGURL          *string     `json:"epg_url"`
	EffectiveEPGURL *string     `json:"effective_epg_url"`
	EPGURLs         []string    `json:"epg_urls"`
	Enabled         bool        `json:"enabled"`
	UserAgent       *string     `json:"user_agent"`
	Referrer        *string     `json:"referrer"`
	ViaProxy        bool        `json:"via_proxy"`
	Position        int         `json:"position"`
	HasContent      bool        `json:"has_content"`
	Refresh         refreshInfo `json:"refresh"`
	EPG             epgInfo     `json:"epg"`
	Stats           stats       `json:"stats"`
	CreatedAt       time.Time   `json:"created_at"`
	UpdatedAt       time.Time   `json:"updated_at"`
}

func (s *Service) present(ctx context.Context, p *playlistRow, st map[string]stats, headers map[string]*string) *AdminPlaylist {
	out := &AdminPlaylist{ID: p.ID, Kind: p.Kind, Name: p.Name, URL: p.URL, Country: p.Country, EPGURL: p.EPGURL,
		Enabled: p.Enabled, UserAgent: p.UserAgent, Referrer: p.Referrer, ViaProxy: p.ViaProxy, Position: p.Position,
		HasContent: p.HasContent, Stats: st[p.ID], CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
		Refresh: refreshInfo{Status: p.RefreshStatus, Error: p.RefreshError, RefreshedAt: p.RefreshedAt, FetchedVia: p.FetchedVia},
		EPG:     epgInfo{Status: p.EPGStatus, Error: p.EPGError, RefreshedAt: p.EPGRefreshedAt}}
	if p.Kind == "m3u_url" && out.URL != nil {
		red := redactURL(*out.URL)
		out.URL = &red
	}
	urls := s.guideURLs(p, headers[p.ID])
	out.EPGURLs, out.EPG.Guides = []string{}, []*GuideState{}
	if len(urls) > 0 {
		out.EffectiveEPGURL = &urls[0]
		ids := make([]string, len(urls))
		for i, u := range urls {
			ids[i] = epgSourceID(u)
		}
		st := s.guideStates(ctx, ids)
		for i, u := range urls {
			g := st[ids[i]]
			g.URL = u
			out.EPGURLs = append(out.EPGURLs, u)
			out.EPG.Guides = append(out.EPG.Guides, g)
			out.EPG.XMLTVChannels += g.XMLTVChannels
			out.EPG.Programmes += g.Programmes
			if g.Status == "running" {
				out.EPG.Status = "running"
			}
		}
	}
	return out
}

// redactURL hides credentials a provider URL may carry in its query
// (…?username=…&password=…) or userinfo. The stored URL is untouched;
// a PATCH without url keeps it.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "…"
	}
	if u.User != nil {
		u.User = url.User("***")
	}
	q := u.Query()
	changed := false
	for k := range q {
		switch strings.ToLower(k) {
		case "password", "pass", "pwd", "token", "key", "apikey", "api_key", "auth", "secret", "username", "user", "login":
			q.Set(k, "***")
			changed = true
		}
	}
	if changed {
		u.RawQuery = q.Encode()
	}
	return u.String()
}

func (s *Service) adminList(c fiber.Ctx) error {
	ctx := c.Context()
	pls, err := s.st.playlists(ctx, false)
	if err != nil {
		return err
	}
	st, err := s.st.stats(ctx)
	if err != nil {
		return err
	}
	headers, err := s.headerEPGs(ctx)
	if err != nil {
		return err
	}
	items := make([]*AdminPlaylist, 0, len(pls))
	for _, p := range pls {
		items = append(items, s.present(ctx, p, st, headers))
	}
	return c.JSON(fiber.Map{"items": items, "totals": st[""], "proxy_configured": s.cfg.ProxyURL != nil,
		"refresh_hours": s.cfg.RefreshHours, "epg_refresh_hours": s.cfg.EPGRefreshHours})
}

func (s *Service) adminGet(c fiber.Ctx, id string, status int) error {
	ctx := c.Context()
	p, err := s.st.playlist(ctx, id)
	if errors.Is(err, errNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	st, err := s.st.stats(ctx)
	if err != nil {
		return err
	}
	headers, err := s.headerEPGs(ctx)
	if err != nil {
		return err
	}
	return c.Status(status).JSON(s.present(ctx, p, st, headers))
}

// playlistInput is AdminIptvPlaylistInput; json.RawMessage tells "absent"
// from null for the nullable fields.
type playlistInput struct {
	Kind      *string         `json:"kind"`
	Name      *string         `json:"name"`
	URL       json.RawMessage `json:"url"`
	Country   json.RawMessage `json:"country"`
	EPGURL    json.RawMessage `json:"epg_url"`
	Enabled   *bool           `json:"enabled"`
	UserAgent json.RawMessage `json:"user_agent"`
	Referrer  json.RawMessage `json:"referrer"`
	ViaProxy  *bool           `json:"via_proxy"`
	Position  *int            `json:"position"`
}

// optString decodes an optional nullable string: set=false when absent;
// "" and null both clear.
func optString(raw json.RawMessage) (val *string, set bool, ok bool) {
	if len(raw) == 0 {
		return nil, false, true
	}
	if string(raw) == "null" {
		return nil, true, true
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return nil, true, false
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, true, true
	}
	return &s, true, true
}

type fieldSet struct {
	val *string
	set bool
}

type validated struct {
	kind                                      string
	name                                      *string
	url, country, epgURL, userAgent, referrer fieldSet
	enabled, viaProxy                         *bool
	position                                  *int
}

func (in playlistInput) validate(create bool, existingKind string) (*validated, map[string]string) {
	f := map[string]string{}
	v := &validated{enabled: in.Enabled, viaProxy: in.ViaProxy, position: in.Position, kind: existingKind}
	if create {
		if in.Kind == nil {
			f["kind"] = "Required."
		} else {
			v.kind = *in.Kind
		}
		switch v.kind {
		case "iptv_org_country", "m3u_url", "m3u_file", "":
		default:
			f["kind"] = "Must be iptv_org_country, m3u_url or m3u_file."
		}
	} else if in.Kind != nil && *in.Kind != existingKind {
		f["kind"] = "Can't be changed."
	}
	if in.Name != nil {
		n := strings.TrimSpace(*in.Name)
		if l := utf8.RuneCountInString(n); l < 1 || l > 100 {
			f["name"] = "1…100 characters."
		}
		v.name = &n
	}
	parse := func(key string, raw json.RawMessage, max int, isURL bool) fieldSet {
		val, set, ok := optString(raw)
		switch {
		case !ok:
			f[key] = "Must be a string or null."
		case val != nil && len(*val) > max:
			f[key] = "Too long."
		case val != nil && isURL && !isHTTP(*val):
			f[key] = "Must be an http(s) URL."
		}
		return fieldSet{val: val, set: set}
	}
	v.url = parse("url", in.URL, 2048, true)
	v.epgURL = parse("epg_url", in.EPGURL, 4096, false)
	if v.epgURL.val != nil {
		urls := splitURLs(*v.epgURL.val)
		n := len(strings.FieldsFunc(*v.epgURL.val, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\r' || r == '\t' || r == ';' }))
		switch {
		case len(urls) == 0 || len(urls) != n:
			f["epg_url"] = "One or more http(s) URLs separated by commas or new lines."
		case len(urls) > maxGuideURLs:
			f["epg_url"] = "At most 5 guides."
		default:
			j := strings.Join(urls, "\n")
			v.epgURL.val = &j
		}
	}
	v.userAgent = parse("user_agent", in.UserAgent, 300, false)
	v.referrer = parse("referrer", in.Referrer, 2048, true)
	v.country = parse("country", in.Country, 8, false)
	if v.country.val != nil {
		lc := strings.ToLower(*v.country.val)
		v.country.val = &lc
		if _, ok := countryByCode(lc); !ok {
			f["country"] = "Unknown country code."
		}
	}
	if v.position != nil && (*v.position < 0 || *v.position > 1000) {
		f["position"] = "0…1000."
	}
	switch v.kind {
	case "iptv_org_country":
		if (create || v.country.set) && v.country.val == nil {
			f["country"] = "Required for iptv_org_country."
		}
	case "m3u_url":
		if (create || v.url.set) && v.url.val == nil {
			f["url"] = "Required for m3u_url."
		}
	}
	return v, f
}

func (s *Service) adminCreate(c fiber.Ctx) error {
	var in playlistInput
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	v, f := in.validate(true, "")
	if len(f) > 0 {
		return httpx.Validation(f)
	}
	name := ""
	if v.name != nil {
		name = *v.name
	}
	if name == "" {
		switch v.kind {
		case "iptv_org_country":
			cn, _ := countryByCode(*v.country.val)
			name = "iptv-org: " + cn.NameRu
		case "m3u_url":
			name = hostOf(*v.url.val)
		default:
			name = "Мой плейлист"
		}
	}
	if v.kind == "iptv_org_country" {
		var exists bool
		_ = s.pool.QueryRow(c.Context(), `SELECT EXISTS (SELECT 1 FROM iptv_playlists WHERE kind = 'iptv_org_country' AND country = $1)`,
			*v.country.val).Scan(&exists)
		if exists {
			return httpx.NewError(fiber.StatusConflict, "playlist_exists", "This country is already added.")
		}
	}
	enabled, via, pos := true, false, 0
	if v.enabled != nil {
		enabled = *v.enabled
	}
	if v.viaProxy != nil {
		via = *v.viaProxy
	}
	if v.position != nil {
		pos = *v.position
	} else {
		_ = s.pool.QueryRow(c.Context(), `SELECT COALESCE(max(position) + 1, 0) FROM iptv_playlists`).Scan(&pos)
	}
	p := auth.PrincipalFrom(c)
	var id string
	var url, country *string
	if v.kind == "m3u_url" {
		url = v.url.val
	}
	if v.kind == "iptv_org_country" {
		country = v.country.val
	}
	err := s.pool.QueryRow(c.Context(), `INSERT INTO iptv_playlists (kind, name, url, country, epg_url, enabled, user_agent, referrer,
		via_proxy, position, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
		v.kind, name, url, country, v.epgURL.val, enabled, v.userAgent.val, v.referrer.val, via, pos, p.UserID).Scan(&id)
	if err != nil {
		return err
	}
	s.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "iptv.playlist_created", TargetType: "iptv_playlist",
		TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: map[string]any{"kind": v.kind, "name": name, "country": country}})
	if enabled && v.kind != "m3u_file" {
		s.StartRefresh(id)
	}
	return s.adminGet(c, id, fiber.StatusCreated)
}

func (s *Service) adminUpdate(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	cur, err := s.st.playlist(c.Context(), id)
	if errors.Is(err, errNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	var in playlistInput
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	v, f := in.validate(false, cur.Kind)
	if len(f) > 0 {
		return httpx.Validation(f)
	}
	sets := []string{}
	args := []any{id}
	changed := []string{}
	add := func(col string, val any) {
		args = append(args, val)
		sets = append(sets, col+" = $"+itoa(len(args)))
		changed = append(changed, col)
	}
	if v.name != nil {
		add("name", *v.name)
	}
	if v.url.set && cur.Kind == "m3u_url" {
		add("url", v.url.val)
	}
	if v.country.set && cur.Kind == "iptv_org_country" {
		add("country", v.country.val)
	}
	if v.epgURL.set {
		add("epg_url", v.epgURL.val)
	}
	if v.userAgent.set {
		add("user_agent", v.userAgent.val)
	}
	if v.referrer.set {
		add("referrer", v.referrer.val)
	}
	if v.enabled != nil {
		add("enabled", *v.enabled)
	}
	if v.viaProxy != nil {
		add("via_proxy", *v.viaProxy)
	}
	if v.position != nil {
		add("position", *v.position)
	}
	if len(sets) > 0 {
		if _, err := s.pool.Exec(c.Context(), `UPDATE iptv_playlists SET `+strings.Join(sets, ", ")+`, updated_at = now() WHERE id = $1`, args...); err != nil {
			return err
		}
		p := auth.PrincipalFrom(c)
		s.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "iptv.playlist_updated", TargetType: "iptv_playlist",
			TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: map[string]any{"fields": changed}})
		// A new source or newly enabled playlist refreshes now.
		if (v.url.set || v.country.set || (v.enabled != nil && *v.enabled && !cur.Enabled)) && (cur.Kind != "m3u_file" || cur.HasContent) {
			s.StartRefresh(id)
		} else if v.epgURL.set {
			s.bg.Add(1)
			go func() {
				defer s.bg.Done()
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
				defer cancel()
				s.refreshGuideFor(ctx, id)
			}()
		}
	}
	return s.adminGet(c, id, fiber.StatusOK)
}

func (s *Service) adminDelete(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	var name string
	err = s.pool.QueryRow(c.Context(), `DELETE FROM iptv_playlists WHERE id = $1 RETURNING name`, id).Scan(&name)
	if err != nil {
		return httpx.NotFound()
	}
	p := auth.PrincipalFrom(c)
	s.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "iptv.playlist_deleted", TargetType: "iptv_playlist",
		TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: map[string]any{"name": name}})
	// Guides nobody uses any more are dropped with their programmes.
	_, _ = s.pool.Exec(c.Context(), `DELETE FROM iptv_epg_sources e WHERE NOT EXISTS
		(SELECT 1 FROM iptv_channels c WHERE c.epg_source = e.id)`)
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Service) adminUpload(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	cur, err := s.st.playlist(c.Context(), id)
	if errors.Is(err, errNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	if cur.Kind != "m3u_file" {
		return httpx.Validation(map[string]string{"kind": "Only m3u_file playlists take an upload."})
	}
	body := c.Body()
	if len(body) > MaxUploadBytes {
		return httpx.NewError(fiber.StatusRequestEntityTooLarge, "payload_too_large", "The playlist is larger than 5 MB.")
	}
	text := strings.TrimPrefix(string(body), "\ufeff")
	if !utf8.ValidString(text) {
		return httpx.Validation(map[string]string{"content": "Must be UTF-8 text."})
	}
	pl, err := ParseM3U(strings.NewReader(text))
	if err != nil || len(pl.Entries) == 0 {
		return httpx.Validation(map[string]string{"content": "No channels found in the playlist."})
	}
	if _, err := s.pool.Exec(c.Context(), `UPDATE iptv_playlists SET content = $2, updated_at = now() WHERE id = $1`, id, text); err != nil {
		return err
	}
	p := auth.PrincipalFrom(c)
	s.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "iptv.playlist_uploaded", TargetType: "iptv_playlist",
		TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: map[string]any{"bytes": len(body), "channels": len(pl.Entries)}})
	s.StartRefresh(id)
	return s.adminGet(c, id, fiber.StatusOK)
}

func (s *Service) adminRefresh(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	cur, err := s.st.playlist(c.Context(), id)
	if errors.Is(err, errNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	if cur.Kind == "m3u_file" && !cur.HasContent {
		return httpx.Validation(map[string]string{"content": "Upload the playlist file first."})
	}
	if !s.StartRefresh(id) {
		return httpx.NewError(fiber.StatusConflict, "refresh_running", "A refresh of this playlist is already running.")
	}
	p := auth.PrincipalFrom(c)
	s.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "iptv.playlist_refreshed", TargetType: "iptv_playlist",
		TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c)})
	return s.adminGet(c, id, fiber.StatusAccepted)
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + string(rune('0'+n%10))
}
