package foryou

import (
	"context"
	"strconv"
	"sync"
	"time"
)

// Explore tile pictures: every tile without its own image (moods, decades,
// countries, genres, themes) shows the backdrop of the top title of its
// own selection — the same query the tile opens. Results are cached per
// tile for a day; a cold cache is filled concurrently, and whatever isn't
// ready within the wait is finished in the background for the next visit.
// The same fetch records the selection's total result count, so Explore
// can hide tiles with nothing in them. Keys include the language and the
// profile's min_votes (it changes the selection).

const (
	tileImageTTL     = 24 * time.Hour
	tileImageWait    = 2500 * time.Millisecond
	tileImageWorkers = 6
)

type tileImage struct {
	paths []string // up to 5 candidate backdrops, best first
	total int      // TMDB total_results of the tile's selection
	at    time.Time
}

type tileImageCache struct {
	mu      sync.Mutex
	entries map[string]tileImage
	pending map[string]bool
}

func (c *tileImageCache) get(key string, now time.Time) (tileImage, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || now.Sub(e.at) > tileImageTTL {
		return tileImage{}, false
	}
	return e, true
}

func (c *tileImageCache) put(key string, e tileImage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]tileImage{}
	}
	c.entries[key] = e
	delete(c.pending, key)
}

// claim marks key as being fetched; false when another request already is.
func (c *tileImageCache) claim(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pending == nil {
		c.pending = map[string]bool{}
	}
	if c.pending[key] {
		return false
	}
	c.pending[key] = true
	return true
}

func (c *tileImageCache) release(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.pending, key)
}

// tileKey is the cache key of a tile's selection.
func tileKey(lang string, minVotes int, tileID string) string {
	return lang + "|" + strconv.Itoa(minVotes) + "|" + tileID
}

// fillTileImages sets ImagePath on tiles that have none, preferring a
// picture no other tile on the page uses, and returns the known result
// counts by tile id (tiles not fetched yet are absent).
func (s *Service) fillTileImages(ctx context.Context, profileID, lang string, minVotes int, sections []ExploreSection) map[string]int {
	now := s.now()
	counts := map[string]int{}
	type ref struct{ si, ti int }
	cands := map[ref][]string{}
	var misses []ref
	for si := range sections {
		for ti, t := range sections[si].Tiles {
			if t.Kind == "collection" {
				continue
			}
			if e, ok := s.tileImgs.get(tileKey(lang, minVotes, t.ID), now); ok {
				counts[t.ID] = e.total
				if t.ImagePath == nil {
					cands[ref{si, ti}] = e.paths
				}
				continue
			}
			misses = append(misses, ref{si, ti})
		}
	}
	if len(misses) > 0 {
		// Fetch in the background (outlives this request); wait a little.
		type result struct {
			r ref
			e tileImage
		}
		results := make(chan result, len(misses))
		bg, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		sem := make(chan struct{}, tileImageWorkers)
		var wg sync.WaitGroup
		for _, r := range misses {
			id := sections[r.si].Tiles[r.ti].ID
			key := tileKey(lang, minVotes, id)
			if !s.tileImgs.claim(key) {
				continue
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				paths, total, ok := s.tileTopImages(bg, profileID, id, lang)
				if !ok {
					s.tileImgs.release(key) // error: retry on a later visit
					return
				}
				e := tileImage{paths: paths, total: total, at: s.now()}
				s.tileImgs.put(key, e)
				results <- result{r, e}
			}()
		}
		go func() {
			wg.Wait()
			cancel()
			close(results)
		}()
		timer := time.NewTimer(tileImageWait)
		defer timer.Stop()
	wait:
		for {
			select {
			case res, ok := <-results:
				if !ok {
					break wait
				}
				counts[sections[res.r.si].Tiles[res.r.ti].ID] = res.e.total
				if sections[res.r.si].Tiles[res.r.ti].ImagePath == nil {
					cands[res.r] = res.e.paths
				}
			case <-timer.C:
				break wait
			case <-ctx.Done():
				break wait
			}
		}
	}
	// Assign in page order, skipping pictures already on the page.
	used := map[string]bool{}
	for _, sec := range sections {
		for _, t := range sec.Tiles {
			if t.ImagePath != nil {
				used[*t.ImagePath] = true
			}
		}
	}
	for si := range sections {
		for ti := range sections[si].Tiles {
			paths := cands[ref{si, ti}]
			if len(paths) == 0 {
				continue
			}
			pick := paths[0]
			for _, p := range paths {
				if !used[p] {
					pick = p
					break
				}
			}
			used[pick] = true
			sections[si].Tiles[ti].ImagePath = &pick
		}
	}
	return counts
}

// dropEmptyTiles removes tiles whose selection is known to be empty
// (collections always stay; unknown counts stay) and then empty sections.
func dropEmptyTiles(sections []ExploreSection, counts map[string]int) []ExploreSection {
	out := sections[:0]
	for _, sec := range sections {
		tiles := sec.Tiles[:0]
		for _, t := range sec.Tiles {
			if n, known := counts[t.ID]; known && n == 0 && t.Kind != "collection" {
				continue
			}
			tiles = append(tiles, t)
		}
		sec.Tiles = tiles
		if len(sec.Tiles) > 0 {
			out = append(out, sec)
		}
	}
	return out
}

// tileTopImages lists up to 5 backdrops from the top of the tile's
// selection and its total result count. ok=false on errors (not cached).
func (s *Service) tileTopImages(ctx context.Context, profileID, tile, lang string) ([]string, int, bool) {
	page, err := s.Browse(ctx, profileID, tile, "", lang, 1)
	if err != nil {
		return nil, 0, false
	}
	var out []string
	for _, m := range page.Items {
		if m.BackdropPath != nil && *m.BackdropPath != "" {
			out = append(out, *m.BackdropPath)
			if len(out) == 5 {
				break
			}
		}
	}
	return out, max(page.TotalResults, len(page.Items)), true
}
