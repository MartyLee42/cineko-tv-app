// Package integrations holds adapters for external services. In Phase 0/1
// each adapter only verifies connectivity and reports the installed version;
// search, streaming and metadata arrive in later phases.
//
// Credentials stay on the server: nothing here is ever returned to clients
// beyond a configured/healthy flag and a version string.
package integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/integrations/jackett"
	"martytv/api/internal/integrations/tmdb"
	"martytv/api/internal/integrations/torrserver"
)

// Status is the health of one integration.
type Status struct {
	Name       string `json:"name"`
	Configured bool   `json:"configured"`
	OK         bool   `json:"ok"`
	Version    string `json:"version,omitempty"`
	// Capabilities lists optional features detected from the installed
	// version (TorrServer only), e.g. ["torrents","stream","ffprobe"].
	Capabilities []string `json:"capabilities,omitempty"`
	// BudgetRemaining is today's remaining request budget (kinopoisk only).
	BudgetRemaining *int      `json:"budget_remaining,omitempty"`
	Error           string    `json:"error,omitempty"`
	CheckedAt       time.Time `json:"checked_at"`
}

// Prober checks one integration.
type Prober interface {
	Name() string
	Probe(ctx context.Context) Status
}

func newHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 8 * time.Second,
		// Never follow redirects to arbitrary hosts with credentials attached.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func getJSON(ctx context.Context, client *http.Client, req *http.Request, out any) error {
	resp, err := client.Do(req.WithContext(ctx))
	if err != nil {
		return sanitize(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected HTTP %d", resp.StatusCode)
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
}

// sanitize strips URLs (which may contain keys in query strings) from errors.
func sanitize(err error) error {
	var ue interface{ Unwrap() error }
	if errors.As(err, &ue) {
		if inner := ue.Unwrap(); inner != nil {
			return errors.New(inner.Error())
		}
	}
	return errors.New("request failed")
}

// ---- Prowlarr ----

type Prowlarr struct {
	cfg    config.ProwlarrConfig
	client *http.Client
}

func NewProwlarr(cfg config.ProwlarrConfig) *Prowlarr {
	return &Prowlarr{cfg: cfg, client: newHTTPClient()}
}

func (p *Prowlarr) Name() string { return "prowlarr" }

// Probe calls GET /api/v1/system/status (verified against Prowlarr 2.4).
func (p *Prowlarr) Probe(ctx context.Context) Status {
	st := Status{Name: p.Name(), Configured: p.cfg.URL != "" && p.cfg.APIKey != "", CheckedAt: time.Now().UTC()}
	if !st.Configured {
		return st
	}
	req, _ := http.NewRequest(http.MethodGet, p.cfg.URL+"/api/v1/system/status", nil)
	req.Header.Set("X-Api-Key", p.cfg.APIKey)
	var body struct {
		AppName string `json:"appName"`
		Version string `json:"version"`
	}
	if err := getJSON(ctx, p.client, req, &body); err != nil {
		st.Error = err.Error()
		return st
	}
	st.OK, st.Version = true, body.Version
	return st
}

// ---- Jackett ----

// Jackett checks the alternative torrent search backend (INDEXER=jackett)
// with an authenticated torznab caps request.
type Jackett struct {
	client *jackett.Client
}

func NewJackett(cfg config.JackettConfig) *Jackett {
	return &Jackett{client: jackett.NewWithTimeout(cfg, 10*time.Second)}
}

func (j *Jackett) Name() string { return "jackett" }

func (j *Jackett) Probe(ctx context.Context) Status {
	st := Status{Name: j.Name(), Configured: j.client.Configured(), CheckedAt: time.Now().UTC()}
	if !st.Configured {
		return st
	}
	if err := j.client.Caps(ctx); err != nil {
		st.Error = err.Error()
		return st
	}
	st.OK = true
	return st
}

// ---- TorrServer ----

type TorrServer struct {
	cfg    config.TorrServerConfig
	client *http.Client
}

func NewTorrServer(cfg config.TorrServerConfig) *TorrServer {
	return &TorrServer{cfg: cfg, client: newHTTPClient()}
}

func (t *TorrServer) Name() string { return "torrserver" }

// Probe reads GET /echo (plain-text version, e.g. "MatriX.141") and then
// verifies credentials with POST /torrents {"action":"list"}, which requires
// auth when TorrServer has it enabled.
func (t *TorrServer) Probe(ctx context.Context) Status {
	st := Status{Name: t.Name(), Configured: t.cfg.URL != "", CheckedAt: time.Now().UTC()}
	if !st.Configured {
		return st
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, t.cfg.URL+"/echo", nil)
	resp, err := t.client.Do(req)
	if err != nil {
		st.Error = sanitize(err).Error()
		return st
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		st.Error = fmt.Sprintf("echo returned HTTP %d", resp.StatusCode)
		return st
	}
	st.Version = strings.TrimSpace(string(b))
	caps := torrserver.CapabilitiesFor(st.Version)
	st.Capabilities = caps.List()
	if !caps.Supported {
		st.Error = "unsupported TorrServer version (need MatriX)"
		return st
	}

	req, _ = http.NewRequestWithContext(ctx, http.MethodPost, t.cfg.URL+"/torrents", strings.NewReader(`{"action":"list"}`))
	req.Header.Set("Content-Type", "application/json")
	if t.cfg.Username != "" {
		req.SetBasicAuth(t.cfg.Username, t.cfg.Password)
	}
	if err := getJSON(ctx, t.client, req, nil); err != nil {
		st.Error = "credentials check failed: " + err.Error()
		return st
	}
	st.OK = true
	return st
}

// ---- TMDB ----

type TMDB struct {
	cfg    config.TMDBConfig
	client *http.Client
}

// NewTMDB uses the TMDB HTTP client so the probe honors TMDB_PROXY_URL.
func NewTMDB(cfg config.TMDBConfig) *TMDB {
	return &TMDB{cfg: cfg, client: tmdb.HTTPClient(cfg, 8*time.Second)}
}

func (t *TMDB) Name() string { return "tmdb" }

// Probe calls GET /configuration with the v4 bearer token or v3 api_key.
func (t *TMDB) Probe(ctx context.Context) Status {
	st := Status{Name: t.Name(), Configured: t.cfg.Configured(), CheckedAt: time.Now().UTC()}
	if !st.Configured {
		return st
	}
	req, _ := http.NewRequest(http.MethodGet, t.cfg.BaseURL+"/configuration", nil)
	if t.cfg.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+t.cfg.AccessToken)
	} else {
		q := req.URL.Query()
		q.Set("api_key", t.cfg.APIKey)
		req.URL.RawQuery = q.Encode()
	}
	if err := getJSON(ctx, t.client, req, nil); err != nil {
		st.Error = err.Error()
		return st
	}
	st.OK, st.Version = true, "v3"
	return st
}

// ---- cached checker ----

// Checker caches probe results so health endpoints stay cheap.
type Checker struct {
	probers []Prober
	ttl     time.Duration
	mu      sync.Mutex
	last    []Status
	at      time.Time
}

func NewChecker(ttl time.Duration, probers ...Prober) *Checker {
	return &Checker{probers: probers, ttl: ttl}
}

func (c *Checker) Statuses(ctx context.Context) []Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.last != nil && time.Since(c.at) < c.ttl {
		return c.last
	}
	out := make([]Status, len(c.probers))
	var wg sync.WaitGroup
	for i, p := range c.probers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out[i] = p.Probe(ctx)
		}()
	}
	wg.Wait()
	c.last, c.at = out, time.Now()
	return out
}
