package iptv

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"time"
)

// iptv-org's channels.json (~8 MB, ~32k channels) gives alternative names
// (e.g. "НТВ" for NTV.ru) that let Latin playlist names match Cyrillic
// XMLTV display names. It is decoded as a stream; only the ids the
// playlists use are kept, cached for a day.
type orgCache struct {
	at    time.Time
	names map[string][]string // lower-case channel id → name + alt names
}

const orgCacheTTL = 24 * time.Hour

func (s *Service) orgAltNames(ctx context.Context, viaProxy bool, want map[string]bool) map[string][]string {
	s.mu.Lock()
	c := s.org
	s.mu.Unlock()
	if c.names == nil || s.now().Sub(c.at) > orgCacheTTL || !covers(c.names, want) {
		names, err := s.fetchOrg(ctx, viaProxy, want, c.names)
		if err != nil {
			s.log.Info("iptv-org channel metadata unavailable", "err", err)
			if c.names == nil {
				return nil
			}
		} else {
			c = orgCache{at: s.now(), names: names}
			s.mu.Lock()
			s.org = c
			s.mu.Unlock()
		}
	}
	out := map[string][]string{}
	for id := range want {
		if n := c.names[id]; len(n) > 0 {
			out[id] = n
		}
	}
	return out
}

// covers: the cache was built for (at least) these ids (cached misses are
// stored as empty slices).
func covers(m map[string][]string, want map[string]bool) bool {
	for id := range want {
		if _, ok := m[id]; !ok {
			return false
		}
	}
	return true
}

func (s *Service) fetchOrg(ctx context.Context, viaProxy bool, want map[string]bool, prev map[string][]string) (map[string][]string, error) {
	body, _, err := s.long.open(ctx, s.cfg.OrgAPIURL+"/channels.json", viaProxy, nil)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	r, err := MaybeGunzip(&limitReader{r: body, n: 64 << 20})
	if err != nil {
		return nil, err
	}
	return decodeOrgChannels(r, want, prev)
}

// decodeOrgChannels streams the channels.json array, keeping the wanted
// ids (plus everything already cached).
func decodeOrgChannels(r io.Reader, want map[string]bool, prev map[string][]string) (map[string][]string, error) {
	dec := json.NewDecoder(r)
	if _, err := dec.Token(); err != nil { // [
		return nil, err
	}
	keep := map[string]bool{}
	for id := range want {
		keep[id] = true
	}
	for id := range prev {
		keep[id] = true
	}
	out := map[string][]string{}
	for dec.More() {
		var ch struct {
			ID       string   `json:"id"`
			Name     string   `json:"name"`
			AltNames []string `json:"alt_names"`
		}
		if err := dec.Decode(&ch); err != nil {
			return nil, err
		}
		id := strings.ToLower(ch.ID)
		if !keep[id] {
			continue
		}
		names := []string{}
		if ch.Name != "" {
			names = append(names, clip(ch.Name, 200))
		}
		for _, a := range ch.AltNames {
			if a = strings.TrimSpace(a); a != "" && len(names) < 12 {
				names = append(names, clip(a, 200))
			}
		}
		out[id] = names
	}
	for id := range keep {
		if _, ok := out[id]; !ok {
			out[id] = []string{} // known miss
		}
	}
	return out, nil
}
