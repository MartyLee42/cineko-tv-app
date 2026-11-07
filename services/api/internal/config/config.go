// Package config loads Cineko settings from environment variables.
//
// Every secret can also be read from a file by setting NAME_FILE instead of
// NAME (for Docker/compose secrets). Secrets are never logged.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// LoginIPLimit is how many logins one IP may try per 5 minutes
	// (LOGIN_IP_LIMIT, default 20; the dev stack raises it for e2e runs).
	LoginIPLimit  int
	ListenAddr    string
	DatabaseURL   string
	PublicBaseURL *url.URL
	// AllowedOrigins are the browser origins allowed to make state-changing
	// requests and open WebSockets. Always includes PublicBaseURL's origin.
	AllowedOrigins []string
	CookieSecure   bool
	// MusicDomain is Cineko Music's own host (MUSIC_DOMAIN, e.g.
	// music.example.com; empty = only /music/ on the main host).
	MusicDomain string
	// CookieDomain is the session cookie's Domain attribute, derived from
	// PUBLIC_BASE_URL + MUSIC_DOMAIN or set by COOKIE_DOMAIN; empty = host-only.
	CookieDomain  string
	SessionSecret []byte
	LogLevel      string
	// TrustedProxies are IPs/CIDRs whose X-Forwarded-For header is trusted.
	TrustedProxies []string

	SessionIdleTTL     time.Duration
	SessionAbsoluteTTL time.Duration
	PairingTTL         time.Duration
	// NewTVDesign is the design a newly paired TV shows for every profile
	// until a design is picked on / for it (NEW_TV_DESIGN, default
	// "wireframe" = «Каркас»; empty or "off" = the profile's design, as
	// before). TVs paired earlier are never touched.
	NewTVDesign string

	// MSXApps is a JSON array of extra Media Station X launcher buttons
	// ({label, icon, url, image}); empty = Lampa.
	MSXApps string
	// MSXBridge serves the launcher through the Cineko MSX interaction plugin
	// (enables "play in MSX's native player"). MSX_BRIDGE=false → plain menu.
	MSXBridge bool

	Prowlarr   ProwlarrConfig
	Jacred     JacredConfig
	TorrServer TorrServerConfig
	TMDB       TMDBConfig
	Catalog    CatalogConfig
	Kinopoisk  KinopoiskConfig
	// ForYou: Phase 6 recommendations and AI collections (config/foryou.go).
	ForYou ForYouConfig
	// NewEpisodes: the nightly «Новые серии» check (config/newepisodes.go).
	NewEpisodes NewEpisodesConfig

	// MetricsToken enables GET /metrics (Prometheus); scrapes send it as a
	// bearer token. Empty = /metrics answers 404.
	MetricsToken string

	// HostmonSocket is the unix socket of martytv-hostmon (host load for the
	// admin Server tab). Missing socket → container-only numbers.
	HostmonSocket string

	// Transcoder is the browser compatibility stream sidecar (audio → AAC,
	// MKV → MP4). Empty URL = off (sources get compat_url: null).
	Transcoder TranscoderConfig

	// IPTV: live TV playlists, EPG and the live proxy (config/iptv.go).
	IPTV IPTVConfig

	// Library: server downloads (config/library.go).
	Library LibraryConfig

	// Segments: intro/credits databases for «Пропустить заставку».
	Segments SegmentsConfig

	// Video: the YouTube «Видео» tab via Invidious (config/video.go).
	Video VideoConfig
	// InvidiousRestart: the nightly Invidious restart (config/invidiousrestart.go).
	InvidiousRestart InvidiousRestartConfig
}

// TranscoderConfig points at services/transcoder on the internal network.
type TranscoderConfig struct {
	URL string
	// Secret signs jobs (shared with the transcoder). Never log it.
	Secret string
}

// Configured reports whether compat streams are available.
func (t TranscoderConfig) Configured() bool { return t.URL != "" && t.Secret != "" }

type ProwlarrConfig struct {
	URL    string
	APIKey string
}

// JacredConfig is the Jacred torrent index (sources provider "jacred").
type JacredConfig struct {
	// URL of a Jacred instance; empty = disabled (JACRED_URL=off).
	URL string
	// APIKey is sent as ?apikey= when the instance requires one. Never log it.
	APIKey string
}

type TorrServerConfig struct {
	URL      string
	Username string
	Password string
}

// SegmentsConfig: base URLs of the intro/credits databases (TheIntroDB by
// TMDB id, IntroDB by IMDb id). "off" disables one. They go through the
// TMDB proxy when one is set.
type SegmentsConfig struct {
	TheIntroDBURL string
	IntroDBURL    string
}

type TMDBConfig struct {
	APIKey       string
	AccessToken  string // v4 read access token; preferred over APIKey when set
	BaseURL      string
	ImageBaseURL string
	// ProxyURL routes TMDB API and image traffic through an HTTP(S)/SOCKS5
	// proxy (e.g. where TMDB is blocked). Nil means direct. May carry
	// credentials in userinfo, so never log it; use Redacted().
	ProxyURL *url.URL
}

// Configured reports whether TMDB credentials are present.
func (t TMDBConfig) Configured() bool { return t.APIKey != "" || t.AccessToken != "" }

type CatalogConfig struct {
	// Region is the default ISO 3166-1 country for watch providers.
	Region string
	// ImageProxy makes clients load images through /api/v1/images instead of
	// directly from TMDB (TVs without internet, regions where TMDB is blocked).
	ImageProxy bool
	// ImageCacheDir holds proxied images on disk.
	ImageCacheDir string
}

// KinopoiskConfig drives Kinopoisk/IMDb ratings (internal/ratings).
// Ratings by Kinopoisk id come from rating.kinopoisk.ru without a key; the
// key is only needed to map TMDB titles to Kinopoisk ids.
type KinopoiskConfig struct {
	// APIKey is the kinopoiskapiunofficial.tech or kinopoisk.dev key. Never log it.
	APIKey string
	// Provider is "unofficial" (kinopoiskapiunofficial.tech) or "dev" (kinopoisk.dev).
	Provider string
	// DailyBudget caps id-mapping API requests per day (Moscow time).
	DailyBudget int
	// APIBaseURL / RatingBaseURL override the endpoints (tests, mirrors).
	APIBaseURL    string
	RatingBaseURL string
	// WikidataURL is the Wikidata SPARQL endpoint used (keyless) to map
	// TMDB/IMDb ids to Kinopoisk ids before the keyed API; "" = off
	// (KINOPOISK_WIKIDATA_URL=off).
	WikidataURL string
	// ProxyURL optionally routes Kinopoisk traffic through a proxy (direct
	// is usually right: the services are in Russia). Never log it.
	ProxyURL *url.URL
}

// Configured reports whether TMDB → Kinopoisk id mapping is possible.
func (k KinopoiskConfig) Configured() bool { return k.APIKey != "" }

var regionPattern = regexp.MustCompile(`^[A-Z]{2}$`)

// Load reads configuration from the process environment.
func Load() (*Config, error) {
	return LoadFrom(func(name string) string {
		// NEW_TV_DESIGN= (set but empty) turns the default off; unset keeps it.
		if v, ok := os.LookupEnv(name); ok && strings.TrimSpace(v) == "" && name == "NEW_TV_DESIGN" {
			return "off"
		}
		return os.Getenv(name)
	})
}

// newTVDesign normalises NEW_TV_DESIGN ("off" / "none" = no default).
func newTVDesign(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	if v == "off" || v == "none" {
		return ""
	}
	return v
}

// LoadFrom reads configuration using getenv (handy for tests).
func LoadFrom(getenv func(string) string) (*Config, error) {
	var errs []error
	get := func(name, def string) string {
		if v := strings.TrimSpace(getenv(name)); v != "" {
			return v
		}
		return def
	}
	secret := func(name string) string {
		if p := strings.TrimSpace(getenv(name + "_FILE")); p != "" {
			b, err := os.ReadFile(p)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s_FILE: %w", name, err))
				return ""
			}
			return strings.TrimSpace(string(b))
		}
		return strings.TrimSpace(getenv(name))
	}
	duration := func(name string, def time.Duration) time.Duration {
		v := get(name, "")
		if v == "" {
			return def
		}
		d, err := time.ParseDuration(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", name, err))
			return def
		}
		return d
	}

	c := &Config{
		ListenAddr:         get("LISTEN_ADDR", ":8080"),
		DatabaseURL:        secret("DATABASE_URL"),
		LogLevel:           get("LOG_LEVEL", "info"),
		MSXApps:            get("MSX_APPS", ""),
		MSXBridge:          get("MSX_BRIDGE", "true") != "false",
		HostmonSocket:      get("HOSTMON_SOCKET", "/run/martytv/hostmon.sock"),
		MetricsToken:       secret("METRICS_TOKEN"),
		SessionIdleTTL:     duration("SESSION_IDLE_TTL", 30*24*time.Hour),
		SessionAbsoluteTTL: duration("SESSION_ABSOLUTE_TTL", 90*24*time.Hour),
		PairingTTL:         duration("PAIRING_TTL", 5*time.Minute),
		NewTVDesign:        newTVDesign(get("NEW_TV_DESIGN", "wireframe")),
		Prowlarr: ProwlarrConfig{
			URL:    strings.TrimRight(get("PROWLARR_URL", ""), "/"),
			APIKey: secret("PROWLARR_API_KEY"),
		},
		Jacred: JacredConfig{
			URL:    jacredURL(get("JACRED_URL", "https://jr.maxvol.pro")),
			APIKey: secret("JACRED_API_KEY"),
		},
		TorrServer: TorrServerConfig{
			URL:      strings.TrimRight(get("TORRSERVER_URL", ""), "/"),
			Username: firstNonEmpty(secret("TORRSERVER_USERNAME"), secret("TORRSERVER_LOGIN")),
			Password: firstNonEmpty(secret("TORRSERVER_PASSWORD"), secret("TORRSERVER_PWD")),
		},
		Segments: SegmentsConfig{
			TheIntroDBURL: strings.TrimRight(get("THEINTRODB_URL", "https://api.theintrodb.org"), "/"),
			IntroDBURL:    strings.TrimRight(get("INTRODB_URL", "https://api.introdb.app"), "/"),
		},
		TMDB: TMDBConfig{
			APIKey:       secret("TMDB_API_KEY"),
			AccessToken:  secret("TMDB_ACCESS_TOKEN"),
			BaseURL:      strings.TrimRight(get("TMDB_BASE_URL", "https://api.themoviedb.org/3"), "/"),
			ImageBaseURL: strings.TrimRight(get("TMDB_IMAGE_BASE_URL", "https://image.tmdb.org/t/p"), "/"),
		},
		Catalog: CatalogConfig{
			Region:        strings.ToUpper(get("CATALOG_REGION", "RU")),
			ImageCacheDir: get("IMAGE_CACHE_DIR", filepath.Join(os.TempDir(), "martytv-images")),
		},
	}
	c.Kinopoisk = KinopoiskConfig{
		APIKey:        secret("KINOPOISK_API_KEY"),
		Provider:      strings.ToLower(get("KINOPOISK_PROVIDER", "unofficial")),
		DailyBudget:   450,
		APIBaseURL:    strings.TrimRight(get("KINOPOISK_API_URL", ""), "/"),
		RatingBaseURL: strings.TrimRight(get("KINOPOISK_RATING_URL", "https://rating.kinopoisk.ru"), "/"),
		WikidataURL:   get("KINOPOISK_WIKIDATA_URL", "https://query.wikidata.org/sparql"),
	}
	if strings.EqualFold(c.Kinopoisk.WikidataURL, "off") {
		c.Kinopoisk.WikidataURL = ""
	}
	switch c.Kinopoisk.Provider {
	case "unofficial":
		if c.Kinopoisk.APIBaseURL == "" {
			c.Kinopoisk.APIBaseURL = "https://kinopoiskapiunofficial.tech"
		}
	case "dev":
		if c.Kinopoisk.APIBaseURL == "" {
			// kinopoisk.dev moved to poiskkino.dev (api.kinopoisk.dev 301s there).
			c.Kinopoisk.APIBaseURL = "https://api.poiskkino.dev"
		}
	default:
		errs = append(errs, fmt.Errorf("KINOPOISK_PROVIDER must be unofficial or dev, got %q", c.Kinopoisk.Provider))
	}
	c.LoginIPLimit = 20
	if v := get("LOGIN_IP_LIMIT", ""); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			errs = append(errs, errors.New("LOGIN_IP_LIMIT must be a positive integer"))
		} else {
			c.LoginIPLimit = n
		}
	}
	if v := get("KINOPOISK_DAILY_BUDGET", ""); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			errs = append(errs, errors.New("KINOPOISK_DAILY_BUDGET must be a non-negative integer"))
		} else {
			c.Kinopoisk.DailyBudget = n
		}
	}
	c.Kinopoisk.ProxyURL = proxyURL("KINOPOISK_PROXY_URL", secret("KINOPOISK_PROXY_URL"), &errs)
	c.ForYou = loadForYou(get, secret, &errs)
	c.NewEpisodes = loadNewEpisodes(get, &errs)
	c.InvidiousRestart = loadInvidiousRestart(get, &errs)
	c.Library = loadLibrary(get, &errs)
	c.Transcoder = TranscoderConfig{URL: strings.TrimRight(get("TRANSCODER_URL", ""), "/"), Secret: secret("TRANSCODER_SECRET")}
	if c.Transcoder.URL != "" {
		if u, err := url.Parse(c.Transcoder.URL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			errs = append(errs, errors.New("TRANSCODER_URL must be an absolute http(s) URL"))
		} else if len(c.Transcoder.Secret) < 32 {
			errs = append(errs, errors.New("TRANSCODER_SECRET must be at least 32 characters when TRANSCODER_URL is set"))
		}
	}

	if !regionPattern.MatchString(c.Catalog.Region) {
		errs = append(errs, fmt.Errorf("CATALOG_REGION must be an ISO 3166-1 alpha-2 code, got %q", c.Catalog.Region))
	}
	if v := get("IMAGE_PROXY", ""); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("IMAGE_PROXY: %w", err))
		}
		c.Catalog.ImageProxy = b
	}
	c.TMDB.ProxyURL = proxyURL("TMDB_PROXY_URL", secret("TMDB_PROXY_URL"), &errs)
	c.IPTV = loadIPTV(get, secret, c.TMDB.ProxyURL, &errs)
	c.Video = loadVideo(get, &errs)

	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL is required"))
	}

	base := get("PUBLIC_BASE_URL", "http://localhost:8080")
	u, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		errs = append(errs, fmt.Errorf("PUBLIC_BASE_URL must be an absolute http(s) URL, got %q", base))
	} else {
		c.PublicBaseURL = u
		c.AllowedOrigins = append(c.AllowedOrigins, u.Scheme+"://"+u.Host)
	}
	for _, o := range splitList(get("ALLOWED_ORIGINS", "")) {
		c.AllowedOrigins = append(c.AllowedOrigins, strings.TrimRight(o, "/"))
	}

	c.loadMusicHost(getenv, &errs)

	c.CookieSecure = c.PublicBaseURL != nil && c.PublicBaseURL.Scheme == "https"
	if v := get("COOKIE_SECURE", ""); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("COOKIE_SECURE: %w", err))
		}
		c.CookieSecure = b
	}

	s := secret("APP_SESSION_SECRET")
	if len(s) < 32 {
		errs = append(errs, errors.New("APP_SESSION_SECRET must be at least 32 characters"))
	}
	c.SessionSecret = []byte(s)

	c.TrustedProxies = splitList(get("TRUSTED_PROXIES", ""))

	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return c, nil
}

// proxyURL validates an optional proxy URL setting. Errors never echo the
// value (it may carry a password).
func proxyURL(name, v string, errs *[]error) *url.URL {
	if v == "" {
		return nil
	}
	u, err := url.Parse(v)
	switch {
	case err != nil:
		*errs = append(*errs, errors.New(name+" is not a valid URL"))
	case u.Host == "" || !validProxyScheme(u.Scheme):
		*errs = append(*errs, errors.New(name+" must be http://, https://, socks5:// or socks5h:// with a host"))
	default:
		return u
	}
	return nil
}

func validProxyScheme(s string) bool {
	switch s {
	case "http", "https", "socks5", "socks5h":
		return true
	}
	return false
}

// jacredURL maps "off"/"none"/"false"/"-" to "" (disabled).
func jacredURL(v string) string {
	switch strings.ToLower(v) {
	case "off", "none", "false", "-", "disabled":
		return ""
	}
	return strings.TrimRight(v, "/")
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
