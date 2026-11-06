package sources

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// probeTTL: a probe result is reused this long (GET /sources never
	// probes synchronously; the admin probe endpoint forces one).
	probeTTL = 30 * time.Minute
	// failLimit consecutive live failures mark a provider unhealthy.
	failLimit = 5
	// configTTL bounds how stale the in-memory admin config may be when
	// another API replica changed it.
	configTTL = time.Minute
)

// Registry holds every provider, its admin config and its health.
type Registry struct {
	pool *pgxpool.Pool
	log  *slog.Logger
	aead cipher.AEAD
	now  func() time.Time

	mu        sync.RWMutex
	order     []string
	providers map[string]Provider
	cfg       map[string]storedConfig
	cfgAt     time.Time
	health    map[string]*healthState
}

type storedConfig struct {
	Enabled     bool
	BaseURL     string
	Credentials map[string]string
	UpdatedAt   time.Time
}

type healthState struct {
	healthy   *bool
	lastError string
	checkedAt *time.Time
	fails     int
}

// NewRegistry creates an empty registry. secret (APP_SESSION_SECRET)
// derives the key that encrypts stored credentials.
func NewRegistry(pool *pgxpool.Pool, secret []byte, log *slog.Logger) *Registry {
	key := sha256.Sum256(append([]byte("martytv/sources/credentials\x00"), secret...))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		panic(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	return &Registry{
		pool: pool, log: log, aead: aead, now: time.Now,
		providers: map[string]Provider{}, cfg: map[string]storedConfig{}, health: map[string]*healthState{},
	}
}

// Register adds a provider (call during startup, before serving). A nil
// provider is ignored so optional constructors can return nil. Registering
// the same id twice replaces the earlier provider.
func (r *Registry) Register(p Provider) {
	if p == nil {
		return
	}
	id := p.Info().ID
	if !IDPattern.MatchString(id) {
		panic("sources: invalid provider id " + id)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.providers[id]; !ok {
		r.order = append(r.order, id)
	}
	r.providers[id] = p
	r.health[id] = &healthState{}
	r.cfgAt = time.Time{} // re-apply config to the new provider on next use
}

// Unregister removes a provider (tests drop the ones that reach the
// internet). Unknown ids are ignored.
func (r *Registry) Unregister(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.providers[id]; !ok {
		return
	}
	delete(r.providers, id)
	delete(r.health, id)
	r.order = slices.DeleteFunc(r.order, func(x string) bool { return x == id })
}

// Provider returns a registered provider by id (regardless of enables).
func (r *Registry) Provider(id string) (Provider, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.providers[id]
	return p, ok
}

// IDs returns all registered provider ids in registration order.
func (r *Registry) IDs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return slices.Clone(r.order)
}

// ---------------------------------------------------------------- config

// loadConfig refreshes admin config from the database (cached configTTL)
// and pushes it to Configurable providers.
func (r *Registry) loadConfig(ctx context.Context, force bool) {
	r.mu.RLock()
	fresh := !force && !r.cfgAt.IsZero() && r.now().Sub(r.cfgAt) < configTTL
	r.mu.RUnlock()
	if fresh {
		return
	}
	cfg := map[string]storedConfig{}
	rows, err := r.pool.Query(ctx, `SELECT id, enabled, settings, secret, updated_at FROM source_config`)
	if err != nil {
		r.log.Warn("source config load failed", "err", err)
		return
	}
	for rows.Next() {
		var id string
		var sc storedConfig
		var settings, secret []byte
		if err := rows.Scan(&id, &sc.Enabled, &settings, &secret, &sc.UpdatedAt); err != nil {
			rows.Close()
			r.log.Warn("source config scan failed", "err", err)
			return
		}
		var s struct {
			BaseURL string `json:"base_url"`
		}
		_ = json.Unmarshal(settings, &s)
		sc.BaseURL = s.BaseURL
		if len(secret) > 0 {
			creds, err := r.decrypt(secret)
			if err != nil {
				r.log.Warn("source credentials undecryptable (secret changed?)", "source", id)
			}
			sc.Credentials = creds
		}
		cfg[id] = sc
	}
	rows.Close()
	r.mu.Lock()
	r.cfg = cfg
	r.cfgAt = r.now()
	type target struct {
		c Configurable
		v Config
	}
	var apply []target
	for _, id := range r.order {
		if c, ok := r.providers[id].(Configurable); ok {
			apply = append(apply, target{c, r.configLocked(id)})
		}
	}
	r.mu.Unlock()
	for _, t := range apply {
		t.c.Configure(t.v)
	}
}

func (r *Registry) configLocked(id string) Config {
	sc, ok := r.cfg[id]
	if !ok {
		return Config{Enabled: true}
	}
	return Config{Enabled: sc.Enabled, BaseURL: sc.BaseURL, Credentials: maps(sc.Credentials)}
}

func maps(m map[string]string) map[string]string {
	if m == nil {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func (r *Registry) encrypt(creds map[string]string) ([]byte, error) {
	plain, err := json.Marshal(creds)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, r.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return r.aead.Seal(nonce, nonce, plain, nil), nil
}

func (r *Registry) decrypt(b []byte) (map[string]string, error) {
	n := r.aead.NonceSize()
	if len(b) < n {
		return nil, errors.New("short ciphertext")
	}
	plain, err := r.aead.Open(nil, b[:n], b[n:], nil)
	if err != nil {
		return nil, err
	}
	var out map[string]string
	return out, json.Unmarshal(plain, &out)
}

// AdminView is GET /admin/sources item: Info plus non-secret config.
type AdminView struct {
	Info
	BaseURL        string     `json:"base_url"`
	HasCredentials bool       `json:"has_credentials"`
	UpdatedAt      *time.Time `json:"updated_at"`
}

// Patch is PATCH /admin/sources/{id}. Nil fields are unchanged.
// Credentials: nil = keep, empty map = clear, otherwise replace.
type Patch struct {
	Enabled     *bool             `json:"enabled"`
	BaseURL     *string           `json:"base_url"`
	Credentials map[string]string `json:"credentials"`
}

// Admin returns the admin view of one provider.
func (r *Registry) Admin(ctx context.Context, id string) (*AdminView, error) {
	r.loadConfig(ctx, false)
	info, ok := r.info(id)
	if !ok {
		return nil, ErrNotFound
	}
	r.mu.RLock()
	sc, has := r.cfg[id]
	r.mu.RUnlock()
	v := &AdminView{Info: info}
	if has {
		v.BaseURL = sc.BaseURL
		v.HasCredentials = len(sc.Credentials) > 0
		t := sc.UpdatedAt
		v.UpdatedAt = &t
	}
	return v, nil
}

// AdminList returns the admin view of every provider.
func (r *Registry) AdminList(ctx context.Context) []AdminView {
	r.loadConfig(ctx, false)
	out := []AdminView{}
	for _, id := range r.IDs() {
		if v, err := r.Admin(ctx, id); err == nil {
			out = append(out, *v)
		}
	}
	return out
}

// Update applies an admin patch (and re-configures the provider).
func (r *Registry) Update(ctx context.Context, id string, p Patch, userID string) error {
	if _, ok := r.Provider(id); !ok {
		return ErrNotFound
	}
	r.loadConfig(ctx, true)
	r.mu.RLock()
	sc, ok := r.cfg[id]
	r.mu.RUnlock()
	if !ok {
		sc = storedConfig{Enabled: true}
	}
	if p.Enabled != nil {
		sc.Enabled = *p.Enabled
	}
	if p.BaseURL != nil {
		sc.BaseURL = *p.BaseURL
	}
	if p.Credentials != nil {
		sc.Credentials = p.Credentials
	}
	var secret []byte
	if len(sc.Credentials) > 0 {
		var err error
		if secret, err = r.encrypt(sc.Credentials); err != nil {
			return err
		}
	}
	settings, _ := json.Marshal(map[string]string{"base_url": sc.BaseURL})
	var uid any
	if userID != "" {
		uid = userID
	}
	if _, err := r.pool.Exec(ctx, `
		INSERT INTO source_config (id, enabled, settings, secret, updated_at, updated_by)
		VALUES ($1, $2, $3, $4, now(), $5)
		ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, settings = EXCLUDED.settings,
			secret = EXCLUDED.secret, updated_at = now(), updated_by = EXCLUDED.updated_by`,
		id, sc.Enabled, settings, secret, uid); err != nil {
		return fmt.Errorf("save source config: %w", err)
	}
	r.loadConfig(ctx, true)
	r.mu.Lock()
	if h := r.health[id]; h != nil {
		*h = healthState{} // settings changed: re-probe
	}
	r.mu.Unlock()
	return nil
}

// ---------------------------------------------------------------- catalog

func (r *Registry) info(id string) (Info, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.providers[id]
	if !ok {
		return Info{}, false
	}
	in := p.Info()
	sc, has := r.cfg[id]
	in.EnabledByAdmin = !has || sc.Enabled
	if h := r.health[id]; h != nil {
		in.Healthy = h.healthy
		in.LastError = h.lastError
		in.CheckedAt = h.checkedAt
	}
	return in, true
}

// List returns every provider's Info (registration order).
func (r *Registry) List(ctx context.Context) []Info {
	r.loadConfig(ctx, false)
	out := []Info{}
	for _, id := range r.IDs() {
		if in, ok := r.info(id); ok {
			out = append(out, in)
		}
	}
	return out
}

// Usable reports whether a provider is enabled by the admin and configured.
func (r *Registry) Usable(ctx context.Context, id string) bool {
	r.loadConfig(ctx, false)
	in, ok := r.info(id)
	return ok && in.EnabledByAdmin && in.Configured
}

// TorrentProviders returns the usable torrent providers the selection allows.
func (r *Registry) TorrentProviders(ctx context.Context, sel Selection) []TorrentProvider {
	var out []TorrentProvider
	for _, id := range r.IDs() {
		p, _ := r.Provider(id)
		tp, ok := p.(TorrentProvider)
		if ok && sel.Allows(id) && r.Usable(ctx, id) {
			out = append(out, tp)
		}
	}
	return out
}

// OnlineProviders returns the usable online/anime providers the selection allows.
func (r *Registry) OnlineProviders(ctx context.Context, sel Selection) []OnlineProvider {
	var out []OnlineProvider
	for _, id := range r.IDs() {
		p, _ := r.Provider(id)
		op, ok := p.(OnlineProvider)
		if ok && sel.Allows(id) && r.Usable(ctx, id) {
			out = append(out, op)
		}
	}
	return out
}

// HasTorrent reports whether any torrent provider is usable at all.
func (r *Registry) HasTorrent(ctx context.Context) bool {
	return len(r.TorrentProviders(ctx, AllSources)) > 0
}

// Online returns one usable online provider by id (for playback).
func (r *Registry) Online(ctx context.Context, id string) (OnlineProvider, error) {
	p, ok := r.Provider(id)
	if !ok {
		return nil, ErrNotFound
	}
	op, ok := p.(OnlineProvider)
	if !ok {
		return nil, ErrNotFound
	}
	if !r.Usable(ctx, id) {
		return nil, ErrDisabled
	}
	return op, nil
}

// ---------------------------------------------------------------- health

// Report records the outcome of a live call; failLimit consecutive
// failures mark the provider unhealthy, a success marks it healthy.
func (r *Registry) Report(id string, err error) {
	if errors.Is(err, context.Canceled) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	h := r.health[id]
	if h == nil {
		return
	}
	now := r.now().UTC()
	if err == nil {
		t := true
		h.healthy, h.lastError, h.fails, h.checkedAt = &t, "", 0, &now
		return
	}
	h.fails++
	h.lastError = err.Error()
	if h.fails >= failLimit {
		f := false
		h.healthy, h.checkedAt = &f, &now
	}
}

// Probe runs a provider's health check now and returns its updated Info.
func (r *Registry) Probe(ctx context.Context, id string) (Info, error) {
	p, ok := r.Provider(id)
	if !ok {
		return Info{}, ErrNotFound
	}
	r.loadConfig(ctx, false)
	pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	err := p.Probe(pctx)
	cancel()
	now := r.now().UTC()
	r.mu.Lock()
	h := r.health[id]
	ok2 := err == nil
	h.healthy, h.checkedAt = &ok2, &now
	h.fails = 0
	h.lastError = ""
	if err != nil {
		h.lastError = err.Error()
	}
	r.mu.Unlock()
	in, _ := r.info(id)
	return in, nil
}

// Run probes usable providers every probeTTL until ctx ends.
func (r *Registry) Run(ctx context.Context) {
	t := time.NewTicker(probeTTL)
	defer t.Stop()
	for {
		for _, id := range r.IDs() {
			if ctx.Err() != nil {
				return
			}
			if r.Usable(ctx, id) {
				if _, err := r.Probe(ctx, id); err != nil && ctx.Err() == nil {
					r.log.Warn("source probe failed", "source", id, "err", err)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
