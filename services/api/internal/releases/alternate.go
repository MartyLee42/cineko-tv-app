package releases

import (
	"context"
	"encoding/json"
	"strings"
	"unicode"
)

// Alternate returns the same upload as r offered by another search result
// that carries a magnet or info hash: Prowlarr has no hash for some trackers
// (RuTracker.org) and their .torrent download sometimes fails, while Jacred
// lists the same topic with its hash. "Same" means the same episode scope,
// the same tracker, a size within 0.5 % (Prowlarr rounds sizes) and mostly the same title
// words. Returns nil when nothing matches.
func (s *Service) Alternate(ctx context.Context, mediaID string, r Release) (*Resolved, error) {
	if r.SizeBytes <= 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT release, magnet_uri, info_hash FROM release_sources
		WHERE media_id = $1 AND release_id <> $2 AND expires_at > $3
		  AND (magnet_uri IS NOT NULL OR info_hash IS NOT NULL)`, mediaID, r.ID, s.now())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var best *Resolved
	bestDiff := 1.0
	for rows.Next() {
		var raw []byte
		var magnet, hash *string
		if err := rows.Scan(&raw, &magnet, &hash); err != nil {
			return nil, err
		}
		var c Release
		if json.Unmarshal(raw, &c) != nil {
			continue
		}
		diff, ok := sameUpload(r, c)
		if !ok || diff >= bestDiff {
			continue
		}
		out := &Resolved{MediaID: mediaID, Release: c}
		switch {
		case magnet != nil && strings.HasPrefix(strings.ToLower(*magnet), "magnet:"):
			out.MagnetURI = *magnet
		case hash != nil && len(*hash) == 40:
			out.MagnetURI = "magnet:?xt=urn:btih:" + strings.ToLower(*hash)
		default:
			continue
		}
		best, bestDiff = out, diff
	}
	return best, rows.Err()
}

// sameUpload reports whether c looks like the same upload as r, and how far
// apart their sizes are (relative).
func sameUpload(r, c Release) (float64, bool) {
	if c.SizeBytes <= 0 || trackerKey(r.Indexer) != trackerKey(c.Indexer) || !sameInts(r.Seasons, c.Seasons) || !sameInts(r.Episodes, c.Episodes) {
		return 0, false
	}
	diff := float64(r.SizeBytes-c.SizeBytes) / float64(r.SizeBytes)
	if diff < 0 {
		diff = -diff
	}
	if diff > 0.005 {
		return 0, false
	}
	a, b := titleWords(r.Title), titleWords(c.Title)
	if len(a) == 0 || len(b) == 0 {
		return 0, false
	}
	common := 0
	for w := range a {
		if b[w] {
			common++
		}
	}
	return diff, float64(common) >= 0.7*float64(min(len(a), len(b)))
}

// trackerKey folds indexer names from different providers to one tracker
// ("RuTracker.org" via Prowlarr, "RuTracker" via Jacred).
func trackerKey(name string) string {
	k := strings.ToLower(name)
	for _, suf := range []string{".org", ".net", ".me", ".ru", ".to"} {
		k = strings.TrimSuffix(k, suf)
	}
	k = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return r
		}
		return -1
	}, k)
	switch k {
	case "nnmclub", "nonameclub":
		return "nnmclub"
	}
	return k
}

func titleWords(t string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.FieldsFunc(strings.ToLower(t), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if len([]rune(w)) >= 2 {
			out[w] = true
		}
	}
	return out
}

func sameInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
