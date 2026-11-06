package releases

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/integrations/prowlarr"
	"martytv/api/internal/sources"
)

// ProviderRef is Release.provider: which torrent provider found a release.
type ProviderRef struct {
	ID   string       `json:"id"`
	Name string       `json:"name"`
	Kind sources.Kind `json:"kind"`
}

var prowlarrRef = ProviderRef{ID: "prowlarr", Name: "Prowlarr", Kind: sources.KindTorrent}

// ProwlarrProvider is the "prowlarr" torrent provider. Behaviour is the
// pre-sources Prowlarr search: every query in parallel, partial failures
// and Prowlarr's per-indexer failures reported as warnings.
type ProwlarrProvider struct {
	client *prowlarr.Client
	now    func() time.Time

	mu       sync.Mutex
	indexers []prowlarr.Indexer
	idxAt    time.Time
}

// NewProwlarrProvider returns the provider (Configured=false without
// PROWLARR_URL / PROWLARR_API_KEY; it is still listed in /sources).
func NewProwlarrProvider(c config.ProwlarrConfig) *ProwlarrProvider {
	return &ProwlarrProvider{client: prowlarr.New(c), now: time.Now}
}

func (p *ProwlarrProvider) Info() sources.Info {
	return sources.Info{ID: prowlarrRef.ID, Kind: sources.KindTorrent, Title: prowlarrRef.Name,
		NeedsCredentials: true, Configured: p.client.Configured()}
}

func (p *ProwlarrProvider) Probe(ctx context.Context) error {
	_, err := p.client.Indexers(ctx)
	return err
}

// WithKey re-adds the API key to a stored download link (resolve time).
func (p *ProwlarrProvider) WithKey(link string) string { return p.client.WithKey(link) }

func (p *ProwlarrProvider) SearchTorrents(ctx context.Context, t sources.Title) (*sources.TorrentResult, error) {
	start := p.now()
	queries := t.Queries
	outcomes := make([]queryOutcome, len(queries))
	var wg sync.WaitGroup
	for i, q := range queries {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := p.client.Search(ctx, prowlarr.SearchRequest{Query: q, Type: "search", Limit: 500})
			outcomes[i] = queryOutcome{res, err}
		}()
	}
	wg.Wait()

	var failed []error
	out := &sources.TorrentResult{}
	for _, o := range outcomes {
		if o.err != nil {
			failed = append(failed, o.err)
			continue
		}
		for i := range o.results {
			out.Torrents = append(out.Torrents, p.torrent(&o.results[i]))
		}
	}
	// Bounded by its own timeout: the search context may be nearly spent.
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	out.Warnings = p.indexerErrors(sctx, start)
	cancel()
	if len(queries) > 0 && len(failed) == len(queries) {
		return nil, failed[0]
	}
	if len(failed) > 0 {
		out.Warnings = append(out.Warnings, sources.SearchWarning{Indexer: "Prowlarr",
			Message: fmt.Sprintf("%d of %d searches failed: %v", len(failed), len(queries), failed[0])})
	}
	return out, nil
}

func (p *ProwlarrProvider) torrent(r *prowlarr.Release) sources.Torrent {
	t := sources.Torrent{
		GUID: r.GUID, Title: r.Title, Indexer: r.Indexer, IndexerID: r.IndexerID, Size: r.Size,
		Seeders: r.Seeders, Leechers: r.Leechers, PublishDate: r.PublishDate, InfoHash: r.InfoHash,
		IMDbID: r.IMDbID, Categories: r.CategoryIDs(), Protocol: r.Protocol,
	}
	switch {
	case r.DownloadURL != "":
		t.DownloadURL = p.client.StripKey(r.DownloadURL)
	case strings.HasPrefix(strings.ToLower(r.MagnetURL), "magnet:"):
		t.MagnetURI = r.MagnetURL
	case r.MagnetURL != "":
		t.DownloadURL = p.client.StripKey(r.MagnetURL) // Prowlarr link that 301s to a magnet
	}
	return t
}

// indexerErrors reports indexers Prowlarr disabled or recorded a failure
// for since the search started (Prowlarr doesn't report per-indexer
// failures in the search response).
func (p *ProwlarrProvider) indexerErrors(ctx context.Context, since time.Time) []sources.SearchWarning {
	names := p.indexerNames(ctx)
	sts, err := p.client.IndexerStatuses(ctx)
	if err != nil {
		return nil
	}
	out := []sources.SearchWarning{}
	now := p.now()
	for _, st := range sts {
		name, ok := names[st.IndexerID]
		if !ok {
			continue // unknown or disabled in Prowlarr
		}
		switch {
		case st.DisabledTill != nil && st.DisabledTill.After(now):
			out = append(out, sources.SearchWarning{Indexer: name, Message: "temporarily disabled by Prowlarr after repeated failures"})
		case st.MostRecentFailure != nil && !st.MostRecentFailure.Before(since.Add(-5*time.Second)):
			out = append(out, sources.SearchWarning{Indexer: name, Message: "search failed"})
		}
	}
	slices.SortFunc(out, func(a, b sources.SearchWarning) int { return strings.Compare(a.Indexer, b.Indexer) })
	return out
}

func (p *ProwlarrProvider) indexerNames(ctx context.Context) map[int]string {
	p.mu.Lock()
	list, at := p.indexers, p.idxAt
	p.mu.Unlock()
	if list == nil || p.now().Sub(at) > 10*time.Minute {
		if l, err := p.client.Indexers(ctx); err == nil {
			list = l
			p.mu.Lock()
			p.indexers, p.idxAt = l, p.now()
			p.mu.Unlock()
		}
	}
	out := map[int]string{}
	for _, ix := range list {
		if ix.Enable {
			out[ix.ID] = ix.Name
		}
	}
	return out
}

// ---------------------------------------------------------------- voices

// VoiceoverFromName maps a provider's voice label ("Дубляж", "LostFilm",
// "AniLiberty") to the contract's Voiceover (language defaults to ru).
func VoiceoverFromName(name, lang string) Voiceover {
	if lang == "" {
		lang = "ru"
	}
	name = strings.TrimSpace(name)
	if k := kindOf(name); k != "" {
		return Voiceover{Kind: &k, Language: lang}
	}
	if vs := parseVoiceovers(name); len(vs) == 1 && vs[0].Studio != nil {
		v := vs[0]
		v.Language = lang
		return v
	}
	s := name
	return Voiceover{Studio: &s, Language: lang}
}

// VoiceoverPreference returns the index of the best-matching preferred
// studio among vs (lower is better), or -1.
func VoiceoverPreference(vs []Voiceover, prefs []string) int { return voiceoverIndex(vs, prefs) }

// mergeVoices adds provider-parsed voice names (Jacred voices[]) that the
// title parse missed.
func mergeVoices(vs []Voiceover, names []string) []Voiceover {
	for _, n := range names {
		v := VoiceoverFromName(n, "ru")
		dup := false
		for _, x := range vs {
			if v.Studio != nil && x.Studio != nil && strings.EqualFold(*x.Studio, *v.Studio) ||
				v.Studio == nil && v.Kind != nil && x.Kind != nil && *x.Kind == *v.Kind {
				dup = true
				break
			}
		}
		if !dup {
			vs = append(vs, v)
		}
	}
	return orderVoiceovers(vs)
}
