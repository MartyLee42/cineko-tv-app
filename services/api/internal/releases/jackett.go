package releases

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/integrations/jackett"
	"martytv/api/internal/sources"
)

var jackettRef = ProviderRef{ID: "jackett", Name: "Jackett", Kind: sources.KindTorrent}

// JackettProvider is the "jackett" torrent provider (INDEXER=jackett). Each
// configured indexer is searched on its own (per query, in parallel, with
// jackett.IndexerTimeout): Jackett's "all" search waits for the slowest
// tracker. A failed or slow indexer becomes a warning.
type JackettProvider struct {
	client *jackett.Client
	now    func() time.Time

	mu    sync.Mutex
	idx   []jackett.Indexer
	idxAt time.Time
}

func NewJackettProvider(c config.JackettConfig) *JackettProvider {
	return newJackettProvider(jackett.New(c))
}

func newJackettProvider(c *jackett.Client) *JackettProvider {
	return &JackettProvider{client: c, now: time.Now}
}

func (p *JackettProvider) Info() sources.Info {
	return sources.Info{ID: jackettRef.ID, Kind: sources.KindTorrent, Title: jackettRef.Name,
		NeedsCredentials: true, Configured: p.client.Configured()}
}

func (p *JackettProvider) Probe(ctx context.Context) error { return p.client.Caps(ctx) }

// WithKey re-adds the API key to a stored download link (resolve time).
func (p *JackettProvider) WithKey(link string) string { return p.client.WithKey(link) }

func (p *JackettProvider) SearchTorrents(ctx context.Context, t sources.Title) (*sources.TorrentResult, error) {
	idx := p.indexers(ctx)
	if len(idx) == 0 {
		return p.searchAll(ctx, t)
	}
	type job struct {
		ix  jackett.Indexer
		res []jackett.Result
		err error
	}
	jobs := make([]job, 0, len(idx)*len(t.Queries))
	for _, ix := range idx {
		for range t.Queries {
			jobs = append(jobs, job{ix: ix})
		}
	}
	var wg sync.WaitGroup
	for i := range jobs {
		q := t.Queries[i%len(t.Queries)]
		wg.Add(1)
		go func() {
			defer wg.Done()
			jobs[i].res, jobs[i].err = p.client.SearchIndexer(ctx, jobs[i].ix.ID, q)
		}()
	}
	wg.Wait()

	out := &sources.TorrentResult{}
	failedQ := map[string]int{} // indexer title → failed queries
	var firstErr error
	for _, j := range jobs {
		for k := range j.res {
			tr := p.torrent(&j.res[k])
			if tr.Indexer == "" {
				tr.Indexer = j.ix.Title
			}
			out.Torrents = append(out.Torrents, tr)
		}
		if j.err != nil {
			failedQ[j.ix.Title]++
			if firstErr == nil {
				firstErr = j.err
			}
		}
	}
	if len(jobs) > 0 && len(out.Torrents) == 0 && sum(failedQ) == len(jobs) {
		return nil, firstErr
	}
	for name, n := range failedQ {
		msg := "search failed"
		if n < len(t.Queries) {
			msg = fmt.Sprintf("%d of %d searches failed", n, len(t.Queries))
		}
		out.Warnings = append(out.Warnings, sources.SearchWarning{Indexer: name, Message: msg})
	}
	slices.SortFunc(out.Warnings, func(a, b sources.SearchWarning) int { return strings.Compare(a.Indexer, b.Indexer) })
	return out, nil
}

func sum(m map[string]int) int {
	n := 0
	for _, v := range m {
		n += v
	}
	return n
}

// indexers is the configured indexer list, cached for 10 minutes (nil when
// Jackett can't list them: the provider then uses the "all" search).
func (p *JackettProvider) indexers(ctx context.Context) []jackett.Indexer {
	p.mu.Lock()
	list, at := p.idx, p.idxAt
	p.mu.Unlock()
	if list != nil && p.now().Sub(at) < 10*time.Minute {
		return list
	}
	lctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	l, err := p.client.Indexers(lctx)
	if err != nil {
		return list // the last good list, if any
	}
	p.mu.Lock()
	p.idx, p.idxAt = l, p.now()
	p.mu.Unlock()
	return l
}

// searchAll is the single "all indexers" search (fallback).
func (p *JackettProvider) searchAll(ctx context.Context, t sources.Title) (*sources.TorrentResult, error) {
	type outcome struct {
		res *jackett.SearchResponse
		err error
	}
	outcomes := make([]outcome, len(t.Queries))
	var wg sync.WaitGroup
	for i, q := range t.Queries {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := p.client.Search(ctx, q)
			outcomes[i] = outcome{r, err}
		}()
	}
	wg.Wait()

	out := &sources.TorrentResult{}
	var failed []error
	failedIdx := map[string]bool{}
	for _, o := range outcomes {
		if o.err != nil {
			failed = append(failed, o.err)
			continue
		}
		for i := range o.res.Results {
			out.Torrents = append(out.Torrents, p.torrent(&o.res.Results[i]))
		}
		for _, ix := range o.res.Indexers {
			if ix.Error != nil && *ix.Error != "" {
				name := ix.Name
				if name == "" {
					name = ix.ID
				}
				failedIdx[name] = true
			}
		}
	}
	if len(t.Queries) > 0 && len(failed) == len(t.Queries) {
		return nil, failed[0]
	}
	for name := range failedIdx {
		// Jackett's error text can quote tracker URLs; keep it generic.
		out.Warnings = append(out.Warnings, sources.SearchWarning{Indexer: name, Message: "search failed"})
	}
	slices.SortFunc(out.Warnings, func(a, b sources.SearchWarning) int { return strings.Compare(a.Indexer, b.Indexer) })
	if len(failed) > 0 {
		out.Warnings = append(out.Warnings, sources.SearchWarning{Indexer: "Jackett",
			Message: fmt.Sprintf("%d of %d searches failed: %v", len(failed), len(t.Queries), failed[0])})
	}
	return out, nil
}

func (p *JackettProvider) torrent(r *jackett.Result) sources.Torrent {
	t := sources.Torrent{
		GUID: r.GUID, Title: r.Title, Indexer: r.Tracker, Size: r.Size,
		Seeders: r.Seeders, Leechers: r.Leechers(), PublishDate: r.PublishDate, InfoHash: strings.ToLower(r.InfoHash),
		Categories: r.Category, Protocol: "torrent",
	}
	if t.Indexer == "" {
		t.Indexer = r.TrackerID
	}
	if t.GUID == "" {
		t.GUID = r.Link
	}
	if r.IMDb != nil && *r.IMDb > 0 && *r.IMDb < 1<<31 {
		t.IMDbID = int(*r.IMDb)
	}
	switch {
	case r.Link != "":
		t.DownloadURL = p.client.StripKey(r.Link)
		if strings.HasPrefix(strings.ToLower(r.MagnetURI), "magnet:") {
			t.MagnetURI = r.MagnetURI
		}
	case strings.HasPrefix(strings.ToLower(r.MagnetURI), "magnet:"):
		t.MagnetURI = r.MagnetURI
	}
	return t
}
