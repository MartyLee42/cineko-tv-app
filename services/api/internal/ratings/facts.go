package ratings

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net/url"
	"regexp"
	"strings"
)

// Kinopoisk «Знаете ли вы, что…» facts and bloopers (internal/trivia shows
// them on a title's «Факты»). Both keyed APIs have them:
//
//	unofficial: GET /api/v2.2/films/{kp}/facts → {total, items:[{text, type: FACT|BLOOPER, spoiler}]}
//	dev:        GET /v1.4/movie/{kp}?selectFields=facts → {facts:[{value, type, spoiler}]}
//
// Texts are HTML fragments (links to people, &laquo;…); Facts returns plain text.

// KPFact is one fact or blooper.
type KPFact struct {
	Text    string
	Blooper bool
	Spoiler bool
}

// FactsProvider is implemented by providers that can list facts.
type FactsProvider interface {
	Facts(ctx context.Context, kpID int) ([]KPFact, error)
}

// ErrNoFacts: no keyed API is configured (or it cannot list facts).
var ErrNoFacts = errors.New("kinopoisk: facts unavailable")

type rawFact struct {
	Text, Type string
	Spoiler    bool
}

func (u *Unofficial) Facts(ctx context.Context, kpID int) ([]KPFact, error) {
	var res struct {
		Items []struct {
			Text    string `json:"text"`
			Type    string `json:"type"`
			Spoiler bool   `json:"spoiler"`
		} `json:"items"`
	}
	if err := getJSON(ctx, u.http, fmt.Sprintf("%s/api/v2.2/films/%d/facts", u.base, kpID), u.key, &res); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	raw := make([]rawFact, 0, len(res.Items))
	for _, it := range res.Items {
		raw = append(raw, rawFact{it.Text, it.Type, it.Spoiler})
	}
	return cleanFacts(raw), nil
}

func (d *Dev) Facts(ctx context.Context, kpID int) ([]KPFact, error) {
	var res struct {
		Facts []struct {
			Value   string `json:"value"`
			Type    string `json:"type"`
			Spoiler bool   `json:"spoiler"`
		} `json:"facts"`
	}
	q := url.Values{"selectFields": {"facts"}}
	if err := getJSON(ctx, d.http, fmt.Sprintf("%s/v1.4/movie/%d?%s", d.base, kpID, q.Encode()), d.key, &res); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	raw := make([]rawFact, 0, len(res.Facts))
	for _, it := range res.Facts {
		raw = append(raw, rawFact{it.Value, it.Type, it.Spoiler})
	}
	return cleanFacts(raw), nil
}

var (
	factTags  = regexp.MustCompile(`<[^>]*>`)
	factSpace = regexp.MustCompile(`\s+`)
)

// FactText turns a Kinopoisk HTML fragment into plain text.
func FactText(s string) string {
	s = factTags.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	s = strings.ReplaceAll(s, " ", " ")
	return strings.TrimSpace(factSpace.ReplaceAllString(s, " "))
}

func cleanFacts(raw []rawFact) []KPFact {
	out := make([]KPFact, 0, len(raw))
	seen := map[string]bool{}
	for _, r := range raw {
		t := FactText(r.Text)
		if len([]rune(t)) < 20 || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, KPFact{Text: t, Blooper: strings.EqualFold(r.Type, "BLOOPER"), Spoiler: r.Spoiler})
	}
	return out
}

// FactsAvailable: a keyed API that can list facts is configured.
func (s *Service) FactsAvailable() bool {
	_, ok := s.prov.(FactsProvider)
	return s.prov != nil && ok
}

// Facts lists a title's Kinopoisk facts through the keyed API: one budget
// unit at high priority (a viewer is waiting), the shared rate limit and
// pause rules. ErrNoFacts without a key, errBudget/paused errors as for
// lookups.
func (s *Service) Facts(ctx context.Context, kpID int) ([]KPFact, error) {
	fp, ok := s.prov.(FactsProvider)
	if s.prov == nil || !ok || kpID <= 0 {
		return nil, ErrNoFacts
	}
	if s.paused(true) {
		return nil, errPaused
	}
	var facts []KPFact
	_, err := s.call(ctx, High, func() ([]Candidate, error) {
		var err error
		facts, err = fp.Facts(ctx, kpID)
		return nil, err
	})
	return facts, err
}
