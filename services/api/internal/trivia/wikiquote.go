package trivia

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Quotes come from Wikiquote. The page is found through Wikidata (the item
// with the title's TMDB id, P4947 movie / P4983 series, and its ru/en
// Wikiquote sitelinks), its wikitext is read with the MediaWiki parse API
// and the quotes are picked out of it (parseQuotes). Wikimedia policy: a
// descriptive User-Agent and a modest rate (one request at a time, ≥ 1 s
// apart per host family).

const (
	userAgent    = "Cineko/1.0 (self-hosted home media center)"
	maxQuotes    = 12
	minQuoteLen  = 8
	maxQuoteLen  = 300
	maxPageBytes = 4 << 20
)

// Quote is one quote and who says it (empty when the page doesn't say).
type Quote struct {
	Text    string  `json:"text"`
	Speaker *string `json:"speaker"`
}

// pages are a title's Wikiquote page names by language ("ru", "en").
type pages map[string]string

type wikimedia struct {
	sparql string                   // Wikidata SPARQL endpoint
	quote  func(lang string) string // Wikiquote API base for a language
	http   *http.Client
	gap    time.Duration

	mu   sync.Mutex
	last time.Time
}

func newWikimedia(sparql string, quote func(string) string, client *http.Client) *wikimedia {
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	return &wikimedia{sparql: sparql, quote: quote, http: client, gap: time.Second}
}

// wait spaces requests ≥ gap apart (one at a time).
func (w *wikimedia) wait(ctx context.Context) error {
	w.mu.Lock()
	d := w.gap - time.Since(w.last)
	w.last = time.Now().Add(max(d, 0))
	w.mu.Unlock()
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (w *wikimedia) get(ctx context.Context, u string, accept string, out any) error {
	if err := w.wait(ctx); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", accept)
	resp, err := w.http.Do(req)
	if err != nil {
		return errors.New("wikimedia: request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("wikimedia: HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, maxPageBytes)).Decode(out)
}

// find returns the title's Wikiquote pages (empty when Wikidata has none).
func (w *wikimedia) find(ctx context.Context, kind string, tmdbID int) (pages, error) {
	prop := "P4947"
	if kind == "series" {
		prop = "P4983"
	}
	q := fmt.Sprintf(`SELECT ?ru ?en WHERE { ?item wdt:%s "%d" .
  OPTIONAL { ?r schema:about ?item; schema:isPartOf <https://ru.wikiquote.org/>; schema:name ?ru }
  OPTIONAL { ?e schema:about ?item; schema:isPartOf <https://en.wikiquote.org/>; schema:name ?en } } LIMIT 3`, prop, tmdbID)
	var res struct {
		Results struct {
			Bindings []map[string]struct {
				Value string `json:"value"`
			} `json:"bindings"`
		} `json:"results"`
	}
	if err := w.get(ctx, w.sparql+"?"+url.Values{"query": {q}}.Encode(), "application/sparql-results+json", &res); err != nil {
		return nil, err
	}
	out := pages{}
	for _, b := range res.Results.Bindings {
		for _, l := range []string{"ru", "en"} {
			if v := strings.TrimSpace(b[l].Value); v != "" && out[l] == "" {
				out[l] = v
			}
		}
	}
	return out, nil
}

// wikitext reads a page's source.
func (w *wikimedia) wikitext(ctx context.Context, lang, page string) (string, error) {
	q := url.Values{"action": {"parse"}, "page": {page}, "prop": {"wikitext"}, "format": {"json"},
		"formatversion": {"2"}, "redirects": {"1"}}
	var res struct {
		Parse struct {
			Wikitext string `json:"wikitext"`
		} `json:"parse"`
		Error *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := w.get(ctx, w.quote(lang)+"?"+q.Encode(), "application/json", &res); err != nil {
		return "", err
	}
	if res.Error != nil {
		return "", nil // missingtitle etc.: no quotes
	}
	return res.Parse.Wikitext, nil
}

// pageURL is the public address of a Wikiquote page.
func pageURL(lang, page string) string {
	return "https://" + lang + ".wikiquote.org/wiki/" + url.PathEscape(strings.ReplaceAll(page, " ", "_"))
}

// ---------------------------------------------------------------- parsing

var (
	reComment    = regexp.MustCompile(`(?s)<!--.*?-->`)
	reRef        = regexp.MustCompile(`(?is)<ref[^>/]*/>|<ref[^>]*>.*?</ref>`)
	reHeading    = regexp.MustCompile(`^(={2,6})\s*(.*?)\s*={2,6}\s*$`)
	reStage      = regexp.MustCompile(`\[\s*''[^\]]*''\s*\]|''\s*[\[(][^\])]*[\])]\s*''`)
	reLink       = regexp.MustCompile(`\[\[(?:[^|\]]*\|)?(?:[a-z]{1,3}:)?([^\]|]*)\]\]`)
	reExtLabel   = regexp.MustCompile(`\[https?://\S+\s+([^\]]+)\]`)
	reExtBare    = regexp.MustCompile(`\[https?://[^\]]*\]`)
	reTemplate   = regexp.MustCompile(`\{\{[^{}]*\}\}`)
	reTag        = regexp.MustCompile(`<[^>]*>`)
	reSpaces     = regexp.MustCompile(`\s+`)
	reQTemplate  = regexp.MustCompile(`(?i)^\{\{\s*(q|quote|цитата)\s*\|`)
	reBold       = regexp.MustCompile(`'''(.+?)'''`)
	reBreak      = regexp.MustCompile(`(?i)<br\s*/?>`)
	reEmptyPar   = regexp.MustCompile(`\(\s*\)|\[\s*\]`)
	reSpacePunc  = regexp.MustCompile(`\s+([.,!?;:])`)
	reDoublePunc = regexp.MustCompile(`([!?…])\.`)
	// "Уолт: …" at the start of a line names the speaker.
	reSpeaker = regexp.MustCompile(`^(\p{Lu}[\p{L}\p{N}\-. ]{0,30}?):\s+(.+)$`)
	// Another "Name:" right after a sentence end: a dialogue squeezed into one line.
	reDialogue = regexp.MustCompile(`[.!?…»"]\s*\p{Lu}[\p{L}\-]{1,20}( \p{Lu}[\p{L}\-]{1,20})?:\s`)
)

// Sections whose bullets are not quotes from the film (or are dialogues,
// which read badly one line at a time).
var skipSections = []string{
	"диалог", "dialog", "tagline", "слоган", "cast", "в ролях", "актёр", "актер", "external", "ссылк", "источник",
	"примечани", "см. также", "see also", "about", "о фильме", "о сериале", "отзыв", "критик", "notes", "reference",
	"misattributed", "disputed", "неверно",
}

// Headings that group quotes without naming a speaker.
var containerSections = []string{"цитат", "quote", "реплик", "сезон", "season", "серия", "episode", "часть", "part", "други", "прочи", "other", "misc"}

func headingKind(name string) (skip, container bool) {
	n := strings.ToLower(name)
	for _, s := range skipSections {
		if strings.Contains(n, s) {
			return true, false
		}
	}
	for _, s := range containerSections {
		if strings.Contains(n, s) {
			return false, true
		}
	}
	return false, false
}

// clean turns a wikitext fragment into plain text.
func clean(s string) string {
	for range 3 {
		s = reLink.ReplaceAllString(s, "$1")
	}
	s = reStage.ReplaceAllString(s, "")
	s = reExtLabel.ReplaceAllString(s, "$1")
	s = reExtBare.ReplaceAllString(s, "")
	for range 3 {
		s = reTemplate.ReplaceAllString(s, "")
	}
	s = strings.NewReplacer("'''", "", "''", "", "&nbsp;", " ").Replace(s)
	s = strings.ReplaceAll(s, "<…>", "…")
	s = reTag.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	s = reEmptyPar.ReplaceAllString(s, "")
	s = reSpaces.ReplaceAllString(s, " ")
	s = reSpacePunc.ReplaceAllString(s, "$1")
	return strings.TrimSpace(reDoublePunc.ReplaceAllString(s, "$1"))
}

// templateText returns the first positional parameter of a {{q|…}} template
// at the start of line (nested links and templates kept intact).
func templateText(line string) (string, bool) {
	loc := reQTemplate.FindStringIndex(line)
	if loc == nil {
		return "", false
	}
	depth, start := 0, loc[1]
	var params []string
	for i := start; i < len(line)-1; i++ {
		switch {
		case line[i] == '{' && line[i+1] == '{', line[i] == '[' && line[i+1] == '[':
			depth++
			i++
		case line[i] == '}' && line[i+1] == '}' && depth == 0:
			params = append(params, line[start:i])
			return firstPositional(params), true
		case line[i] == '}' && line[i+1] == '}', line[i] == ']' && line[i+1] == ']':
			depth--
			i++
		case line[i] == '|' && depth == 0:
			params = append(params, line[start:i])
			start = i + 1
		}
	}
	return "", false
}

func firstPositional(params []string) string {
	for _, p := range params {
		if eq := strings.Index(p, "="); eq > 0 && !strings.ContainsAny(p[:eq], " [{") {
			continue // named parameter (Оригинал=, Комментарий=, автор=…)
		}
		return p
	}
	return ""
}

// usable: a quote of a sensible length with no markup left over.
func usable(t string) bool {
	n := utf8.RuneCountInString(t)
	return n >= minQuoteLen && n <= maxQuoteLen && !strings.ContainsAny(t, "{}[]|") && !strings.Contains(t, "http")
}

// pick cleans a quote; a long one is cut down to its bold parts (English
// Wikiquote bolds the famous line of a long speech).
func pick(raw string) string {
	t := clean(raw)
	if utf8.RuneCountInString(t) <= maxQuoteLen {
		return t
	}
	var parts []string
	for _, m := range reBold.FindAllStringSubmatch(raw, -1) {
		if p := clean(m[1]); p != "" {
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return t
	}
	return strings.Join(parts, " … ")
}

// parseQuotes picks up to maxQuotes quotes from a Wikiquote page: `* …`
// bullets and {{q|…}} templates, the nearest named heading as the speaker,
// taken round-robin across speakers (in page order) so the list is varied.
func parseQuotes(wikitext string) []Quote {
	wikitext = reRef.ReplaceAllString(reComment.ReplaceAllString(wikitext, ""), "")
	type group struct {
		speaker string
		quotes  []string
	}
	var groups []*group
	byName := map[string]*group{}
	speaker, skipping := "", false
	skipLevel := 0
	seen := map[string]bool{}
	for _, line := range strings.Split(wikitext, "\n") {
		line = strings.TrimSpace(line)
		if m := reHeading.FindStringSubmatch(line); m != nil {
			level, name := len(m[1]), clean(m[2])
			if skipping && level > skipLevel {
				continue
			}
			skip, container := headingKind(name)
			skipping, skipLevel = skip, level
			switch {
			case skip, container:
				speaker = ""
			default:
				speaker = name
			}
			continue
		}
		if skipping {
			continue
		}
		var raw string
		if t, ok := templateText(line); ok {
			raw = t
		} else if strings.HasPrefix(line, "*") && !strings.HasPrefix(line, "**") && !strings.HasPrefix(line, "*:") {
			raw = strings.TrimSpace(line[1:])
		} else {
			continue
		}
		if reBreak.MatchString(raw) {
			continue // lines joined by <br>: a dialogue
		}
		t, who := pick(raw), speaker
		if m := reSpeaker.FindStringSubmatch(t); m != nil {
			if reDialogue.MatchString(m[2]) {
				continue
			}
			t = m[2]
			if who == "" {
				who = strings.TrimSpace(m[1])
			}
		}
		if !usable(t) || seen[t] {
			continue
		}
		seen[t] = true
		g := byName[who]
		if g == nil {
			g = &group{speaker: who}
			byName[who] = g
			groups = append(groups, g)
		}
		g.quotes = append(g.quotes, t)
	}
	out := []Quote{}
	for round := 0; len(out) < maxQuotes; round++ {
		added := false
		for _, g := range groups {
			if round < len(g.quotes) && len(out) < maxQuotes {
				q := Quote{Text: g.quotes[round]}
				if g.speaker != "" {
					sp := g.speaker
					q.Speaker = &sp
				}
				out = append(out, q)
				added = true
			}
		}
		if !added {
			break
		}
	}
	return out
}
