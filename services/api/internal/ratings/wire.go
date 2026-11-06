package ratings

import (
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/config"
)

// NewFromConfig builds the service from KINOPOISK_* settings. Without a key
// the provider is nil (only Wikidata resolves ids); with
// KINOPOISK_WIKIDATA_URL=off as well, ids are never resolved and ratings
// stay null.
func NewFromConfig(cfg config.KinopoiskConfig, pool *pgxpool.Pool, tmdbClient TMDB, log *slog.Logger) *Service {
	client := HTTPClient(cfg.ProxyURL, 8*time.Second)
	var prov Provider
	if cfg.Configured() {
		if cfg.Provider == "dev" {
			prov = NewDev(cfg.APIBaseURL, cfg.APIKey, client)
		} else {
			prov = NewUnofficial(cfg.APIBaseURL, cfg.APIKey, client)
		}
	}
	var wd *WikidataClient
	if cfg.WikidataURL != "" {
		// Direct (never the Kinopoisk proxy), no redirects, 30 s timeout.
		wd = NewWikidata(cfg.WikidataURL, HTTPClient(nil, wikidataTimeout))
	}
	return New(Options{
		Store:    NewPGStore(pool),
		Provider: prov,
		Wikidata: wd,
		Ratings:  NewRatingClient(cfg.RatingBaseURL, client),
		TMDB:     tmdbClient,
		Budget:   cfg.DailyBudget,
		Log:      log,
	})
}
