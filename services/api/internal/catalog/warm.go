package catalog

import (
	"context"
	"time"
)

const (
	warmEvery   = 3 * time.Hour
	warmInitial = 30 * time.Second
)

// Run keeps the home rows warm for both catalog languages and prunes old
// cache rows until ctx is cancelled. It does nothing when TMDB isn't
// configured. Warming every 3h with a 6h list TTL means home rows are
// always served from cache. That is 14 TMDB requests per run: well within
// the TMDB terms (no bulk scraping).
func (s *Service) Run(ctx context.Context) {
	if !s.Available() {
		return
	}
	t := time.NewTimer(warmInitial)
	defer t.Stop()
	force := false // first run after (re)start only fills what's missing
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		for _, lang := range []string{"en", "ru"} {
			if _, err := s.Home(ctx, lang, force); err != nil && ctx.Err() == nil {
				s.log.Warn("catalog warm-up failed", "lang", lang, "err", err)
			}
		}
		if err := s.CleanupCache(ctx); err != nil && ctx.Err() == nil {
			s.log.Warn("tmdb cache cleanup failed", "err", err)
		}
		force = true
		t.Reset(warmEvery)
	}
}
