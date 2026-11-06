package iptv

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// Guide window kept in the database: −1 day … +2 days around the refresh.
const (
	epgPast        = 24 * time.Hour
	epgFuture      = 48 * time.Hour
	maxProgrammes  = 1_000_000
	maxEPGBytes    = 6 << 30 // decompressed
	maxXMLChannels = 300_000
	maxGuideURLs   = 5
)

// ---------------------------------------------------------------- guide lists

// splitURLs reads a list of http(s) URLs separated by commas, spaces or
// newlines (admin epg_url, playlist headers, IPTV_ORG_EPG_URL).
func splitURLs(s string) []string {
	var out []string
	for _, u := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\r' || r == '\t' || r == ';' }) {
		if isHTTP(u) {
			out = appendUnique(out, u)
		}
	}
	return out
}

// templateGuides expands IPTV_ORG_EPG_URL for a country.
func (s *Service) templateGuides(cc string) []string {
	r := strings.NewReplacer("{CC}", strings.ToUpper(cc), "{cc}", strings.ToLower(cc))
	return splitURLs(r.Replace(s.cfg.OrgEPGURL))
}

// guideURLs are the guides a playlist uses, in priority order: the admin's
// epg_url list, else the playlist header's x-tvg-url list, else (iptv-org
// presets) the country's default list.
func (s *Service) guideURLs(p *playlistRow, header *string) []string {
	var out []string
	switch {
	case p.EPGURL != nil && strings.TrimSpace(*p.EPGURL) != "":
		out = splitURLs(*p.EPGURL)
	case header != nil && *header != "":
		out = splitURLs(*header)
	case p.Kind == "iptv_org_country" && p.Country != nil && !s.cfg.OrgEPGOff:
		if s.cfg.OrgEPGURL != "" {
			out = s.templateGuides(*p.Country)
		} else {
			out = presetGuides(*p.Country)
		}
	}
	if len(out) > maxGuideURLs {
		out = out[:maxGuideURLs]
	}
	return out
}

// guideUse is one XMLTV URL and the playlists using it.
type guideUse struct {
	URL       string
	Playlists []string
	ViaProxy  bool
}

// guidePlan maps every guide in use to its playlists, and every enabled
// playlist to its guide ids in priority order.
type guidePlan struct {
	guides map[string]*guideUse
	order  map[string][]string // playlist id → guide ids
}

func (s *Service) plan(ctx context.Context) (*guidePlan, error) {
	pls, err := s.st.playlists(ctx, true)
	if err != nil {
		return nil, err
	}
	headers, err := s.headerEPGs(ctx)
	if err != nil {
		return nil, err
	}
	gp := &guidePlan{guides: map[string]*guideUse{}, order: map[string][]string{}}
	for _, p := range pls {
		gp.order[p.ID] = []string{}
		for _, u := range s.guideURLs(p, headers[p.ID]) {
			id := epgSourceID(u)
			g := gp.guides[id]
			if g == nil {
				g = &guideUse{URL: u}
				gp.guides[id] = g
			}
			g.Playlists = append(g.Playlists, p.ID)
			g.ViaProxy = g.ViaProxy || p.ViaProxy
			gp.order[p.ID] = append(gp.order[p.ID], id)
		}
	}
	return gp, nil
}

func (s *Service) headerEPGs(ctx context.Context) (map[string]*string, error) {
	rows, err := s.pool.Query(ctx, `SELECT id::text, header_epg_url FROM iptv_playlists`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*string{}
	for rows.Next() {
		var id string
		var h *string
		if err := rows.Scan(&id, &h); err != nil {
			return nil, err
		}
		out[id] = h
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- scheduling

// refreshGuideFor refreshes every guide a playlist uses (after a playlist
// refresh: new channels need matching even when the guides are fresh).
func (s *Service) refreshGuideFor(ctx context.Context, playlistID string) {
	gp, err := s.plan(ctx)
	if err != nil {
		return
	}
	ids := gp.order[playlistID]
	if len(ids) == 0 {
		_ = s.st.setEPGStatus(ctx, []string{playlistID}, "none", nil)
		return
	}
	_ = s.st.setEPGStatus(ctx, []string{playlistID}, "running", nil)
	for _, sid := range ids {
		if ctx.Err() != nil {
			break
		}
		s.refreshGuide(ctx, sid, gp.guides[sid])
	}
	affected := []string{playlistID}
	for _, sid := range ids {
		affected = append(affected, gp.guides[sid].Playlists...)
	}
	s.settle(context.WithoutCancel(ctx), gp, affected...)
}

// refreshDueGuides refreshes every guide older than EPGRefreshHours.
func (s *Service) refreshDueGuides(ctx context.Context) {
	gp, err := s.plan(ctx)
	if err != nil {
		return
	}
	var none []string
	for pid, ids := range gp.order {
		if len(ids) == 0 {
			none = append(none, pid)
		}
	}
	if len(none) > 0 {
		_, _ = s.pool.Exec(ctx, `UPDATE iptv_playlists SET epg_status = 'none', epg_error = NULL
			WHERE id = ANY($1) AND epg_status <> 'none'`, none)
	}
	due := s.now().Add(-time.Duration(s.cfg.EPGRefreshHours) * time.Hour)
	for sid, g := range gp.guides {
		if ctx.Err() != nil {
			return
		}
		var fetched *time.Time
		var status string
		err := s.pool.QueryRow(ctx, `SELECT fetched_at, status FROM iptv_epg_sources WHERE id = $1`, sid).Scan(&fetched, &status)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if fetched != nil && fetched.After(due) {
			continue
		}
		if status == "error" && fetched != nil && fetched.After(s.now().Add(-time.Hour)) {
			continue
		}
		_ = s.st.setEPGStatus(ctx, g.Playlists, "running", nil)
		s.refreshGuide(ctx, sid, g)
		s.settle(context.WithoutCancel(ctx), gp, g.Playlists...)
	}
}

// ---------------------------------------------------------------- one guide

// guideProgress is the live state of a running guide refresh (admin).
type guideProgress struct {
	Phase string `json:"phase"` // download | parse | store
	Bytes int64  `json:"bytes"`
	Total int64  `json:"total"` // −1 = unknown
}

type progressMap struct {
	mu sync.Mutex
	m  map[string]guideProgress
}

func (p *progressMap) set(id string, g guideProgress) {
	p.mu.Lock()
	if p.m == nil {
		p.m = map[string]guideProgress{}
	}
	p.m[id] = g
	p.mu.Unlock()
}

func (p *progressMap) get(id string) (guideProgress, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	g, ok := p.m[id]
	return g, ok
}

func (p *progressMap) done(id string) {
	p.mu.Lock()
	delete(p.m, id)
	p.mu.Unlock()
}

type candidate struct {
	ID string
	mc matchChannel
}

// refreshGuide downloads one XMLTV to a temp file (resumable, with an
// overall deadline), parses it from disk, matches its channels against
// every playlist using it and stores the programmes (−1…+2 days) and
// matches of channels that have programmes. Channel links are resolved
// afterwards by settle (first guide in a playlist's order wins).
func (s *Service) refreshGuide(ctx context.Context, sid string, g *guideUse) {
	s.mu.Lock()
	if s.epgRun[sid] {
		s.mu.Unlock()
		return
	}
	s.epgRun[sid] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.epgRun, sid)
		s.mu.Unlock()
		s.progress.done(sid)
	}()
	log := s.log.With("epg_source", sid, "host", hostOf(g.URL))
	started := time.Now()
	fail := func(msg string, bytes int64, via string) {
		log.Warn("iptv guide refresh failed", "err", msg)
		_, _ = s.pool.Exec(context.WithoutCancel(ctx), `INSERT INTO iptv_epg_sources (id, url, status, error, fetched_at, bytes, took_ms, fetched_via)
			VALUES ($1, $2, 'error', $3, now(), $4, $5, NULLIF($6, ''))
			ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, status = 'error', error = EXCLUDED.error, fetched_at = now(),
				bytes = EXCLUDED.bytes, took_ms = EXCLUDED.took_ms, fetched_via = EXCLUDED.fetched_via`,
			sid, g.URL, clip(msg, 500), bytes, time.Since(started).Milliseconds(), via)
	}

	cands, err := s.candidates(ctx, g.Playlists)
	if err != nil {
		fail("loading channels failed", 0, "")
		return
	}
	dir := s.workDir()
	path := filepath.Join(dir, sid+".part")
	defer os.Remove(path)
	o := s.dlOpts
	o.Progress = func(got, total int64) {
		s.progress.set(sid, guideProgress{Phase: "download", Bytes: got, Total: total})
	}
	s.progress.set(sid, guideProgress{Phase: "download", Total: -1})
	via, size, err := s.dl.downloadTo(ctx, g.URL, g.ViaProxy, path, o)
	if err != nil {
		fail(err.Error(), size, "")
		return
	}
	log.Info("iptv guide downloaded", "bytes", size, "via", via, "took", time.Since(started).Round(time.Millisecond))
	s.progress.set(sid, guideProgress{Phase: "parse", Bytes: size, Total: size})

	res, err := s.parseGuide(ctx, path, sid, cands)
	if err != nil {
		fail(err.Error(), size, via)
		return
	}
	s.progress.set(sid, guideProgress{Phase: "store", Bytes: size, Total: size})
	if err := s.storeGuide(ctx, sid, g.URL, size, via, time.Since(started), res); err != nil {
		log.Error("iptv store guide failed", "err", err)
		fail("storing the guide failed", size, via)
		return
	}
	log.Info("iptv guide refreshed", "xmltv_channels", res.xmlChannels, "matched", len(res.matches), "channels", len(cands),
		"programmes", len(res.progs), "truncated", res.truncated, "took", time.Since(started).Round(time.Millisecond))
}

func (s *Service) workDir() string {
	if s.guideDir != "" {
		if err := os.MkdirAll(s.guideDir, 0o700); err == nil {
			return s.guideDir
		}
	}
	return os.TempDir()
}

type guideResult struct {
	xmlChannels int
	matches     map[string]string // channel id → xmltv id (with programmes)
	progs       []progRow
	truncated   bool
}

// parseGuide reads a downloaded guide from disk.
func (s *Service) parseGuide(ctx context.Context, path, sid string, cands []candidate) (*guideResult, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	now := s.now()
	from, to := now.Add(-epgPast), now.Add(epgFuture)
	idx := newEPGIndex()
	res := &guideResult{}
	var (
		matched map[string]string // channel id → xmltv id
		wanted  map[string]bool
		pending = map[string]int{} // xmltv id → index in progs of a programme without stop
	)
	doMatch := func() {
		matched, wanted = map[string]string{}, map[string]bool{}
		for _, c := range cands {
			if x := idx.match(c.mc); x != "" {
				matched[c.ID] = x
				wanted[x] = true
			}
		}
	}
	err = parseXMLTV(&limitReader{r: f, n: maxEPGBytes},
		func(c XChannel) error {
			if res.xmlChannels >= maxXMLChannels {
				return nil
			}
			res.xmlChannels++
			idx.add(c.ID, c.Names)
			return nil
		},
		func(ch string) bool {
			if matched == nil {
				doMatch() // XMLTV lists channels before programmes
			}
			return wanted[ch]
		},
		func(p XProgramme) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if i, ok := pending[p.Channel]; ok {
				if p.Start.After(res.progs[i].Start) {
					res.progs[i].Stop = p.Start
				}
				delete(pending, p.Channel)
			}
			stop := p.Stop
			if !stop.IsZero() && (!stop.After(from) || !p.Start.Before(to)) {
				return nil
			}
			if stop.IsZero() && (p.Start.Before(from.Add(-12*time.Hour)) || !p.Start.Before(to)) {
				return nil
			}
			if len(res.progs) >= maxProgrammes {
				res.truncated = true
				return errStop
			}
			r := progRow{Source: sid, Channel: p.Channel, Start: p.Start, Stop: stop, Title: p.Title}
			if p.Description != "" {
				d := p.Description
				r.Desc = &d
			}
			if p.Category != "" {
				c := p.Category
				r.Category = &c
			}
			res.progs = append(res.progs, r)
			if stop.IsZero() {
				pending[p.Channel] = len(res.progs) - 1
			}
			return nil
		})
	if err != nil {
		if errors.Is(err, errTooLarge) {
			return nil, fmt.Errorf("too_large: guide over %s uncompressed", mb(maxEPGBytes))
		}
		return nil, err
	}
	if matched == nil {
		doMatch()
	}
	kept := res.progs[:0]
	seen := map[string]bool{}
	has := map[string]bool{}
	for _, p := range res.progs {
		if p.Stop.IsZero() {
			p.Stop = p.Start.Add(time.Hour)
		}
		if !p.Stop.After(from) {
			continue
		}
		k := p.Channel + "\x00" + p.Start.String()
		if seen[k] {
			continue // duplicate start (primary key)
		}
		seen[k] = true
		has[p.Channel] = true
		kept = append(kept, p)
	}
	res.progs = kept
	// Only matches with programmes count: a later guide may cover the rest.
	res.matches = map[string]string{}
	for id, x := range matched {
		if has[x] {
			res.matches[id] = x
		}
	}
	return res, nil
}

func (s *Service) candidates(ctx context.Context, playlists []string) ([]candidate, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, COALESCE(tvg_id, ''), name, alt_names
		FROM iptv_channels WHERE active AND playlist_id = ANY($1)`, playlists)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []candidate
	for rows.Next() {
		var c candidate
		var name string
		var alt []string
		if err := rows.Scan(&c.ID, &c.mc.TvgID, &name, &alt); err != nil {
			return nil, err
		}
		c.mc.Names = matchNames(name, c.mc.TvgID, alt)
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Service) storeGuide(ctx context.Context, sid, url string, bytes int64, via string, took time.Duration, res *guideResult) error {
	ctx = context.WithoutCancel(ctx)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `INSERT INTO iptv_epg_sources (id, url, status, error, fetched_at, channel_count, programme_count,
			bytes, took_ms, fetched_via, matched)
		VALUES ($1, $2, 'ok', NULL, now(), $3, $4, $5, $6, $7, $8)
		ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, status = 'ok', error = NULL, fetched_at = now(),
			channel_count = EXCLUDED.channel_count, programme_count = EXCLUDED.programme_count, bytes = EXCLUDED.bytes,
			took_ms = EXCLUDED.took_ms, fetched_via = EXCLUDED.fetched_via, matched = EXCLUDED.matched`,
		sid, url, res.xmlChannels, len(res.progs), bytes, took.Milliseconds(), via, len(res.matches)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM iptv_programmes WHERE epg_source = $1`, sid); err != nil {
		return err
	}
	if len(res.progs) > 0 {
		_, err := tx.CopyFrom(ctx, pgx.Identifier{"iptv_programmes"},
			[]string{"epg_source", "epg_channel", "start_at", "stop_at", "title", "description", "category"},
			pgx.CopyFromSlice(len(res.progs), func(i int) ([]any, error) {
				p := res.progs[i]
				return []any{p.Source, p.Channel, p.Start, p.Stop, p.Title, p.Desc, p.Category}, nil
			}))
		if err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM iptv_epg_matches WHERE epg_source = $1`, sid); err != nil {
		return err
	}
	if len(res.matches) > 0 {
		ids, xs := make([]string, 0, len(res.matches)), make([]string, 0, len(res.matches))
		for id, x := range res.matches {
			ids, xs = append(ids, id), append(xs, x)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO iptv_epg_matches (epg_source, channel_id, epg_channel)
			SELECT $1, k.id, k.x FROM unnest($2::uuid[], $3::text[]) AS k(id, x) JOIN iptv_channels c ON c.id = k.id`,
			sid, ids, xs); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ---------------------------------------------------------------- merge

// settle links each channel of the playlists to the first guide in its
// playlist's order that matched it (with programmes), and sets the
// playlists' guide status from their guides' last results.
func (s *Service) settle(ctx context.Context, gp *guidePlan, playlists ...string) {
	for _, pid := range uniqueStrings(playlists) {
		order := gp.order[pid]
		if err := s.relink(ctx, pid, order); err != nil {
			s.log.Warn("iptv relink failed", "playlist_id", pid, "err", err)
		}
		s.playlistGuideStatus(ctx, pid, order)
	}
}

func (s *Service) relink(ctx context.Context, playlistID string, order []string) error {
	rank := map[string]int{}
	for i, sid := range order {
		rank[sid] = i
	}
	rows, err := s.pool.Query(ctx, `SELECT m.channel_id::text, m.epg_source, m.epg_channel FROM iptv_epg_matches m
		JOIN iptv_channels c ON c.id = m.channel_id WHERE c.playlist_id = $1 AND m.epg_source = ANY($2)`, playlistID, order)
	if err != nil {
		return err
	}
	type link struct {
		src, ch string
		rank    int
	}
	best := map[string]link{}
	for rows.Next() {
		var id, src, ch string
		if err := rows.Scan(&id, &src, &ch); err != nil {
			rows.Close()
			return err
		}
		if b, ok := best[id]; !ok || rank[src] < b.rank {
			best[id] = link{src, ch, rank[src]}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	ids, srcs, chs := []string{}, []string{}, []string{}
	for id, l := range best {
		ids, srcs, chs = append(ids, id), append(srcs, l.src), append(chs, l.ch)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `UPDATE iptv_channels SET epg_source = NULL, epg_channel = NULL
		WHERE playlist_id = $1 AND epg_channel IS NOT NULL AND NOT (id = ANY($2::uuid[]))`, playlistID, ids); err != nil {
		return err
	}
	if len(ids) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE iptv_channels c SET epg_source = k.s, epg_channel = k.x
			FROM unnest($1::uuid[], $2::text[], $3::text[]) AS k(id, s, x) WHERE c.id = k.id`, ids, srcs, chs); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// playlistGuideStatus: ok when at least one guide worked (failures listed
// in epg_error), error when all failed, none without guides.
func (s *Service) playlistGuideStatus(ctx context.Context, pid string, order []string) {
	if len(order) == 0 {
		_ = s.st.setEPGStatus(ctx, []string{pid}, "none", nil)
		return
	}
	st := s.guideStates(ctx, order)
	ok := 0
	var errs []string
	for _, sid := range order {
		g := st[sid]
		switch g.Status {
		case "ok":
			ok++
		case "error":
			errs = append(errs, hostOf(g.URL)+": "+deref(g.Error))
		}
	}
	var msg *string
	if len(errs) > 0 {
		m := strings.Join(errs, "; ")
		if ok > 0 {
			m = fmt.Sprintf("%d of %d guides failed — %s", len(errs), len(order), m)
		}
		m = clip(m, 1000)
		msg = &m
	}
	status := "ok"
	if ok == 0 && len(errs) > 0 {
		status = "error"
	} else if ok == 0 {
		status = "never"
	}
	_ = s.st.setEPGStatus(ctx, []string{pid}, status, msg)
}

// GuideState is one guide of a playlist (admin).
type GuideState struct {
	ID            string         `json:"-"`
	URL           string         `json:"url"`
	Status        string         `json:"status"` // never | running | ok | error
	Error         *string        `json:"error"`
	FetchedAt     *time.Time     `json:"fetched_at"`
	Bytes         int64          `json:"bytes"`
	TookMS        int            `json:"took_ms"`
	FetchedVia    *string        `json:"fetched_via"`
	XMLTVChannels int            `json:"xmltv_channels"`
	Programmes    int            `json:"programmes"`
	Matched       int            `json:"matched"`
	Progress      *guideProgress `json:"progress"`
}

func (s *Service) guideStates(ctx context.Context, ids []string) map[string]*GuideState {
	out := map[string]*GuideState{}
	rows, err := s.pool.Query(ctx, `SELECT id, url, status, error, fetched_at, bytes, took_ms, fetched_via, channel_count, programme_count, matched
		FROM iptv_epg_sources WHERE id = ANY($1)`, ids)
	if err == nil {
		for rows.Next() {
			var g GuideState
			if rows.Scan(&g.ID, &g.URL, &g.Status, &g.Error, &g.FetchedAt, &g.Bytes, &g.TookMS, &g.FetchedVia, &g.XMLTVChannels,
				&g.Programmes, &g.Matched) == nil {
				out[g.ID] = &g
			}
		}
		rows.Close()
	}
	s.mu.Lock()
	running := map[string]bool{}
	for id := range s.epgRun {
		running[id] = true
	}
	s.mu.Unlock()
	for _, id := range ids {
		g := out[id]
		if g == nil {
			g = &GuideState{ID: id, Status: "never"}
			out[id] = g
		}
		if running[id] {
			g.Status = "running"
			if p, ok := s.progress.get(id); ok {
				p := p
				g.Progress = &p
			}
		}
	}
	return out
}

func uniqueStrings(xs []string) []string {
	var out []string
	for _, x := range xs {
		out = appendUnique(out, x)
	}
	return out
}
