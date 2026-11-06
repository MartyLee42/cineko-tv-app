package config

import (
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestLoadRequiresSecrets(t *testing.T) {
	_, err := LoadFrom(env(map[string]string{}))
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL") || !strings.Contains(err.Error(), "APP_SESSION_SECRET") {
		t.Fatalf("expected missing-config errors, got %v", err)
	}
}

func TestLoadDefaultsAndAliases(t *testing.T) {
	c, err := LoadFrom(env(map[string]string{
		"DATABASE_URL":       "postgres://x",
		"APP_SESSION_SECRET": strings.Repeat("s", 32),
		"PUBLIC_BASE_URL":    "https://tv.example.com/",
		"ALLOWED_ORIGINS":    "http://localhost:5173, ",
		"TORRSERVER_URL":     "http://ts:8090/",
		"TORRSERVER_LOGIN":   "u",
		"TORRSERVER_PWD":     "p",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !c.CookieSecure {
		t.Fatal("https base URL should imply secure cookies")
	}
	if len(c.AllowedOrigins) != 2 || c.AllowedOrigins[0] != "https://tv.example.com" {
		t.Fatalf("origins %v", c.AllowedOrigins)
	}
	if c.TorrServer.URL != "http://ts:8090" || c.TorrServer.Username != "u" || c.TorrServer.Password != "p" {
		t.Fatalf("torrserver %+v", c.TorrServer)
	}
}

func TestCatalogConfig(t *testing.T) {
	base := map[string]string{"DATABASE_URL": "postgres://x", "APP_SESSION_SECRET": strings.Repeat("s", 32)}
	c, err := LoadFrom(env(base))
	if err != nil {
		t.Fatal(err)
	}
	if c.Catalog.Region != "RU" || c.Catalog.ImageProxy || c.Catalog.ImageCacheDir == "" || c.TMDB.ProxyURL != nil {
		t.Fatalf("defaults %+v proxy=%v", c.Catalog, c.TMDB.ProxyURL)
	}
	if c.TMDB.Configured() {
		t.Fatal("TMDB should be unconfigured without credentials")
	}

	with := func(kv ...string) map[string]string {
		m := map[string]string{}
		for k, v := range base {
			m[k] = v
		}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}
	c, err = LoadFrom(env(with("CATALOG_REGION", "us", "IMAGE_PROXY", "true", "IMAGE_CACHE_DIR", "/data/img",
		"TMDB_PROXY_URL", "socks5h://user:pw@vpn-proxy:10809", "TMDB_API_KEY", "k")))
	if err != nil {
		t.Fatal(err)
	}
	if c.Catalog.Region != "US" || !c.Catalog.ImageProxy || c.Catalog.ImageCacheDir != "/data/img" || !c.TMDB.Configured() {
		t.Fatalf("catalog %+v", c.Catalog)
	}
	if c.TMDB.ProxyURL == nil || c.TMDB.ProxyURL.Host != "vpn-proxy:10809" {
		t.Fatalf("proxy %v", c.TMDB.ProxyURL)
	}

	for _, bad := range [][]string{
		{"CATALOG_REGION", "RUS"},
		{"IMAGE_PROXY", "maybe"},
		{"TMDB_PROXY_URL", "ftp://host:21"},
		{"TMDB_PROXY_URL", "socks5://"},
		{"KINOPOISK_PROVIDER", "imdb"},
		{"KINOPOISK_DAILY_BUDGET", "-1"},
		{"KINOPOISK_PROXY_URL", "ftp://host"},
	} {
		if _, err := LoadFrom(env(with(bad...))); err == nil {
			t.Fatalf("%v should fail", bad)
		}
	}
	// Errors must not leak proxy credentials.
	_, err = LoadFrom(env(with("TMDB_PROXY_URL", "ftp://user:hunter2@host")))
	if err == nil || strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("unexpected error %v", err)
	}

	// Kinopoisk: defaults, provider-specific base URLs.
	c, err = LoadFrom(env(base))
	if err != nil {
		t.Fatal(err)
	}
	if k := c.Kinopoisk; k.Configured() || k.Provider != "unofficial" || k.DailyBudget != 450 ||
		k.APIBaseURL != "https://kinopoiskapiunofficial.tech" || k.RatingBaseURL != "https://rating.kinopoisk.ru" || k.ProxyURL != nil ||
		k.WikidataURL != "https://query.wikidata.org/sparql" {
		t.Fatalf("kinopoisk defaults %+v", k)
	}
	c, err = LoadFrom(env(with("KINOPOISK_API_KEY", "kp", "KINOPOISK_PROVIDER", "dev", "KINOPOISK_DAILY_BUDGET", "100",
		"KINOPOISK_WIKIDATA_URL", "off")))
	if err != nil {
		t.Fatal(err)
	}
	if k := c.Kinopoisk; !k.Configured() || k.APIBaseURL != "https://api.poiskkino.dev" || k.DailyBudget != 100 || k.WikidataURL != "" {
		t.Fatalf("kinopoisk dev %+v", k)
	}
}
