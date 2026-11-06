// Package jacred is the "jacred" torrent provider: a Jacred index
// (github.com/jacred-fdb/jacred) of ~25 RU trackers. It returns magnets and
// parsed voice-over names without per-tracker logins.
//
// Verified against the public instance jr.maxvol.pro (2026-10-29):
//
//	GET /api/v1.0/torrents?search=<ru title>&altname=<original>&exact=true[&apikey=]
//
// returns a flat JSON array of {tracker, url, title, size, createTime, sid,
// pir, magnet, name, originalname, relased, quality, videotype, voices[],
// seasons[], types[]}. exact=true matches the name/originalname exactly
// (Матрица → ~200 results instead of ~900 for a substring search).
package jacred

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/sources"
)

const (
	maxBody = 16 << 20
	timeout = 20 * time.Second
)

// Item is one Jacred result (fields Cineko reads).
type Item struct {
	Tracker      string   `json:"tracker"`
	URL          string   `json:"url"`
	Title        string   `json:"title"`
	Size         float64  `json:"size"`
	CreateTime   string   `json:"createTime"`
	Sid          int      `json:"sid"`
	Pir          int      `json:"pir"`
	Magnet       string   `json:"magnet"`
	Name         string   `json:"name"`
	OriginalName string   `json:"originalname"`
	Released     int      `json:"relased"`
	Quality      int      `json:"quality"`
	Voices       []string `json:"voices"`
	Seasons      []int    `json:"seasons"`
	Types        []string `json:"types"`
}

// Provider implements sources.TorrentProvider.
type Provider struct {
	http *http.Client

	mu      sync.RWMutex
	baseURL string // effective (admin override or env)
	envURL  string
	apiKey  string
}

// New returns the provider, or nil when JACRED_URL is off.
func New(c config.JacredConfig) sources.Provider {
	if c.URL == "" {
		return nil
	}
	return NewProvider(c)
}

// NewProvider always returns a provider (tests, admin-only configuration).
func NewProvider(c config.JacredConfig) *Provider {
	return &Provider{
		http: &http.Client{
			Timeout:       timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		baseURL: c.URL, envURL: c.URL, apiKey: c.APIKey,
	}
}

func (p *Provider) Info() sources.Info {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return sources.Info{ID: "jacred", Kind: sources.KindTorrent, Title: "Jacred", Configured: p.baseURL != ""}
}

// Configure applies the admin base URL override and an optional API key
// (credentials {"apikey": "…"}).
func (p *Provider) Configure(c sources.Config) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.baseURL = p.envURL
	if c.BaseURL != "" {
		p.baseURL = strings.TrimRight(c.BaseURL, "/")
	}
	if k := c.Credentials["apikey"]; k != "" {
		p.apiKey = k
	}
}

func (p *Provider) Probe(ctx context.Context) error {
	_, err := p.Search(ctx, "Матрица", "The Matrix", true)
	return err
}

// Search runs one Jacred query.
func (p *Provider) Search(ctx context.Context, search, altname string, exact bool) ([]Item, error) {
	p.mu.RLock()
	base, key := p.baseURL, p.apiKey
	p.mu.RUnlock()
	if base == "" {
		return nil, errors.New("jacred: not configured")
	}
	q := url.Values{"search": {search}}
	if altname != "" && altname != search {
		q.Set("altname", altname)
	}
	if exact {
		q.Set("exact", "true")
	}
	if key != "" {
		q.Set("apikey", key)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/v1.0/torrents?"+q.Encode(), nil)
	if err != nil {
		return nil, errors.New("jacred: bad base URL")
	}
	req.Header.Set("Accept", "application/json")
	res, err := p.http.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err // never echo the URL (may carry the apikey)
		}
		return nil, fmt.Errorf("jacred: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jacred: unexpected HTTP %d", res.StatusCode)
	}
	var items []Item
	if err := json.NewDecoder(io.LimitReader(res.Body, maxBody)).Decode(&items); err != nil {
		return nil, fmt.Errorf("jacred: bad response: %w", err)
	}
	return items, nil
}

// SearchTorrents runs one exact title search (ru title + original as
// altname), or the user's own text without exact matching.
func (p *Provider) SearchTorrents(ctx context.Context, t sources.Title) (*sources.TorrentResult, error) {
	var items []Item
	var err error
	if t.UserQuery != "" {
		items, err = p.Search(ctx, t.UserQuery, "", false)
	} else {
		search := firstNonEmpty(t.TitleRU, t.Original, t.TitleEN)
		alt := firstNonEmpty(t.Original, t.TitleEN)
		if search == "" {
			return &sources.TorrentResult{}, nil
		}
		items, err = p.Search(ctx, search, alt, true)
	}
	if err != nil {
		return nil, err
	}
	out := &sources.TorrentResult{Torrents: make([]sources.Torrent, 0, len(items))}
	for _, it := range items {
		if tr, ok := it.torrent(); ok {
			out.Torrents = append(out.Torrents, tr)
		}
	}
	return out, nil
}

var btihRe = regexp.MustCompile(`(?i)urn:btih:([0-9a-f]{40})`)

// trackerNames maps Jacred tracker ids to the names Prowlarr users know.
var trackerNames = map[string]string{
	"rutracker": "RuTracker", "rutor": "RuTor", "kinozal": "Kinozal", "nnmclub": "NoNaMe Club",
	"megapeer": "MegaPeer", "bitru": "BitRu", "selezen": "Selezen", "toloka": "Toloka",
	"lostfilm": "LostFilm", "anilibria": "AniLibria", "aniliberty": "AniLiberty", "anifilm": "AniFilm",
	"torrentby": "TorrentBy", "ultradox": "Ultradox", "korsars": "Korsars", "baibako": "BaibaKo",
}

func (it Item) torrent() (sources.Torrent, bool) {
	if it.Title == "" || !strings.HasPrefix(strings.ToLower(it.Magnet), "magnet:") {
		return sources.Torrent{}, false
	}
	tr := sources.Torrent{
		GUID:      it.URL,
		Title:     it.Title,
		Indexer:   indexerName(it.Tracker),
		Size:      int64(it.Size),
		MagnetURI: it.Magnet,
		Protocol:  "torrent",
		Voices:    it.Voices,
	}
	if tr.GUID == "" {
		tr.GUID = it.Magnet
	}
	if m := btihRe.FindStringSubmatch(it.Magnet); m != nil {
		tr.InfoHash = strings.ToLower(m[1])
	}
	sid, pir := it.Sid, it.Pir
	tr.Seeders, tr.Leechers = &sid, &pir
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05"} {
		if ts, err := time.Parse(layout, it.CreateTime); err == nil && ts.Year() > 1990 {
			ts = ts.UTC()
			tr.PublishDate = &ts
			break
		}
	}
	return tr, true
}

func indexerName(tracker string) string {
	if n, ok := trackerNames[strings.ToLower(tracker)]; ok {
		return n
	}
	if tracker == "" {
		return "Jacred"
	}
	return strings.ToUpper(tracker[:1]) + tracker[1:]
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}
