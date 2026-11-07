// martytv-music: a self-hosted music streaming service ("Cineko Music") that
// lives at /music next to Cineko, as its own container.
//
//   - Catalog (search, charts, artists, albums, playlists, radio): Deezer's
//     public API, no key.
//   - Playback: each catalog track is matched to a YouTube upload through the
//     household's Invidious, and the AAC audio is proxied (no client ever
//     talks to YouTube). Albums can also be played losslessly from torrents
//     found with Prowlarr and streamed by TorrServer.
//   - Accounts: the Cineko session cookie (checked against the Cineko API);
//     the library (likes, playlists, history) is per Cineko account, in a
//     SQLite file of this service.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type config struct {
	Listen    string
	DataDir   string
	StaticDir string // the app built for /music/
	// RootStaticDir is the app built for "/" (Music on its own host,
	// MUSIC_DOMAIN); empty = not served.
	RootStaticDir string
	CinekoURL     string // PUBLIC_BASE_URL: the main Cineko site
	APIURL        string // Cineko API (session check)
	DevUser       string // skips the session check (local development only)
	InvidiousURL  string
	ProwlarrURL   string
	ProwlarrKey   string
	TorrURL       string
	TorrUser      string
	TorrPass      string
	DeezerURL     string
	LyricsURL     string
	ProxyURL      string // optional proxy for Deezer / LRCLIB / images
	MaxTranscode  int
	AIKey         string
	AIBase        string
	AIModel       string
	AIPerDay      int
	AIDayTokens   int   // DeepSeek tokens per Moscow day, all accounts (0 = unlimited)
	CacheBytes    int64 // YouTube audio disk cache
	Region        string
	MetricsToken  string // GET /metrics bearer token; empty = 404
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

// secret reads NAME or the file named by NAME_FILE.
func secret(k string) string {
	if v := env(k, ""); v != "" {
		return v
	}
	if f := env(k+"_FILE", ""); f != "" {
		if b, err := os.ReadFile(f); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return ""
}

func loadConfig() config {
	gb, _ := strconv.ParseFloat(env("MUSIC_CACHE_GB", "10"), 64)
	n, _ := strconv.Atoi(env("MUSIC_MAX_TRANSCODES", "4"))
	aiDay, _ := strconv.Atoi(env("MUSIC_AI_DAILY_PER_USER", "40"))
	aiTokens, _ := strconv.Atoi(env("MUSIC_AI_DAILY_TOKENS", "150000"))
	if n < 1 {
		n = 1
	}
	return config{
		Listen:        env("LISTEN_ADDR", ":8080"),
		DataDir:       env("MUSIC_DATA_DIR", "/data"),
		StaticDir:     env("MUSIC_STATIC_DIR", "/srv/music"),
		RootStaticDir: env("MUSIC_ROOT_STATIC_DIR", "/srv/music-root"),
		CinekoURL:     strings.TrimRight(env("PUBLIC_BASE_URL", ""), "/"),
		APIURL:        strings.TrimRight(env("MARTYTV_API_URL", "http://api:8080"), "/"),
		DevUser:       env("MUSIC_DEV_USER", ""),
		InvidiousURL:  strings.TrimRight(env("INVIDIOUS_URL", ""), "/"),
		ProwlarrURL:   strings.TrimRight(env("PROWLARR_URL", ""), "/"),
		ProwlarrKey:   secret("PROWLARR_API_KEY"),
		TorrURL:       strings.TrimRight(env("TORRSERVER_URL", ""), "/"),
		TorrUser:      firstNonEmpty(secret("TORRSERVER_USERNAME"), secret("TORRSERVER_LOGIN")),
		TorrPass:      firstNonEmpty(secret("TORRSERVER_PASSWORD"), secret("TORRSERVER_PWD")),
		DeezerURL:     strings.TrimRight(env("DEEZER_URL", "https://api.deezer.com"), "/"),
		LyricsURL:     strings.TrimRight(env("LRCLIB_URL", "https://lrclib.net"), "/"),
		ProxyURL:      env("MUSIC_PROXY_URL", ""),
		MaxTranscode:  n,
		AIKey:         secret("DEEPSEEK_API_KEY"),
		AIBase:        env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
		AIModel:       env("DEEPSEEK_MODEL", "deepseek-chat"),
		AIPerDay:      aiDay,
		AIDayTokens:   aiTokens,
		CacheBytes:    int64(gb * (1 << 30)),
		Region:        env("MUSIC_REGION", "RU"),
		MetricsToken:  secret("METRICS_TOKEN"),
	}
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	level := slog.LevelInfo
	if strings.EqualFold(env("LOG_LEVEL", ""), "debug") {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	cfg := loadConfig()
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		log.Error("data dir", "err", err)
		os.Exit(1)
	}
	st, err := openStore(cfg.DataDir + "/music.db")
	if err != nil {
		log.Error("database", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	app := newApp(cfg, st, log)
	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           app.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// No WriteTimeout: audio streams last as long as the track.
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Info("martytv-music listening", "addr", cfg.Listen,
		"invidious", cfg.InvidiousURL != "", "prowlarr", cfg.ProwlarrURL != "" && cfg.ProwlarrKey != "",
		"torrserver", cfg.TorrURL != "", "ai", cfg.AIKey != "", "dev_user", cfg.DevUser != "")
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server", "err", err)
		os.Exit(1)
	}
}

func healthcheck() int {
	addr := env("LISTEN_ADDR", ":8080")
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 1
	}
	if host == "" {
		host = "127.0.0.1"
	}
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get(fmt.Sprintf("http://%s/music/healthz", net.JoinHostPort(host, port)))
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
