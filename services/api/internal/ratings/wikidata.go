package ratings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Wikidata maps titles to Kinopoisk ids without a key or a budget, through
// the Wikidata Query Service (SPARQL). Properties:
//
//	P2603 Kinopoisk film ID   P4947 TMDB movie ID
//	P4983 TMDB TV series ID   P345  IMDb ID
//
// One query looks up a whole batch (TMDB ids by kind, plus IMDb ids where
// known). Wikimedia policy: a descriptive User-Agent, modest rate, honor
// 429/Retry-After. The client sends at most one query at a time, spaced
// ≥ minGap apart, and stops (returns ErrWikidataBackoff) after a 429, a 5xx
// or a transport failure until the back-off ends.
const (
	WikidataDefaultURL = "https://query.wikidata.org/sparql"
	wikidataUA         = "Cineko/1.0 (self-hosted; contact: admin)"
	wikidataBatch      = 150
	wikidataGap        = time.Second
	wikidataTimeout    = 30 * time.Second
	wikidataBackoffMin = 30 * time.Second
	wikidataBackoffMax = 30 * time.Minute
	wikidataMaxBody    = 8 << 20
)

// ErrWikidataBackoff: the query service asked us to slow down (or failed);
// no request was made.
var ErrWikidataBackoff = errors.New("wikidata: backing off")

// WDTitle is what a Wikidata lookup needs about one title.
type WDTitle struct {
	ID     string
	Kind   string // movie | series
	TMDBID int
	IMDbID string
}

// WDResult is the outcome of a lookup: confident matches by title id; every
// other title that was queried is a miss. Conflicts (several Kinopoisk ids,
// or an IMDb id contradicting ours) count as misses too.
type WDResult struct {
	Found     map[string]int
	Queried   []string // ids actually looked up (found or not)
	Conflicts int
	Queries   int
}

type WikidataClient struct {
	url    string
	http   *http.Client
	batch  int
	minGap time.Duration
	now    func() time.Time
	sleep  func(ctx context.Context, d time.Duration) error

	reqMu sync.Mutex // one query at a time

	mu       sync.Mutex
	last     time.Time // last request start
	until    time.Time // back-off end
	backoff  time.Duration
	lastErr  error
	lastOK   time.Time
	failedAt time.Time
}

// NewWikidata builds a client for the SPARQL endpoint at base.
func NewWikidata(base string, client *http.Client) *WikidataClient {
	if client == nil {
		client = &http.Client{Timeout: wikidataTimeout}
	}
	return &WikidataClient{url: base, http: client, batch: wikidataBatch, minGap: wikidataGap,
		now: time.Now, sleep: sleepCtx}
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
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

// BackoffRemaining is how long the client refuses to query.
func (c *WikidataClient) BackoffRemaining() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return max(c.until.Sub(c.now()), 0)
}

// Health reports the last outcome (for the admin status).
func (c *WikidataClient) Health() (lastOK time.Time, lastErr error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastOK, c.lastErr
}

var imdbRe = regexp.MustCompile(`^tt\d{5,10}$`)

// Lookup resolves titles in batches (one query per batch). Titles with
// nothing to ask (unknown kind and no IMDb id) are reported as queried
// misses without a request. On an error the result holds the batches done
// so far.
func (c *WikidataClient) Lookup(ctx context.Context, titles []WDTitle) (WDResult, error) {
	res := WDResult{Found: map[string]int{}}
	var ask []WDTitle
	for _, t := range titles {
		if !imdbRe.MatchString(t.IMDbID) {
			t.IMDbID = ""
		}
		if t.TMDBID <= 0 || (t.Kind != "movie" && t.Kind != "series") {
			t.TMDBID = 0
		}
		if t.TMDBID == 0 && t.IMDbID == "" {
			res.Queried = append(res.Queried, t.ID)
			continue
		}
		ask = append(ask, t)
	}
	for start := 0; start < len(ask); start += c.batch {
		chunk := ask[start:min(start+c.batch, len(ask))]
		bindings, err := c.Select(ctx, buildWDQuery(chunk))
		if err != nil {
			return res, err
		}
		rows := toWDRows(bindings)
		res.Queries++
		for _, t := range chunk {
			res.Queried = append(res.Queried, t.ID)
			switch kp, st := pickWD(t, rows); st {
			case wdFound:
				res.Found[t.ID] = kp
			case wdConflict:
				res.Conflicts++
			}
		}
	}
	return res, nil
}

func buildWDQuery(ts []WDTitle) string {
	var movies, shows, imdb []string
	seen := map[string]bool{}
	add := func(list *[]string, key, v string) {
		if !seen[key+v] {
			seen[key+v] = true
			*list = append(*list, `"`+v+`"`)
		}
	}
	for _, t := range ts {
		if t.TMDBID > 0 {
			if t.Kind == "series" {
				add(&shows, "s", strconv.Itoa(t.TMDBID))
			} else {
				add(&movies, "m", strconv.Itoa(t.TMDBID))
			}
		}
		if t.IMDbID != "" {
			add(&imdb, "i", t.IMDbID)
		}
	}
	var parts []string
	if len(movies) > 0 {
		parts = append(parts, `{ VALUES ?tm { `+strings.Join(movies, " ")+` } ?item wdt:P4947 ?tm . }`)
	}
	if len(shows) > 0 {
		parts = append(parts, `{ VALUES ?tv { `+strings.Join(shows, " ")+` } ?item wdt:P4983 ?tv . }`)
	}
	if len(imdb) > 0 {
		parts = append(parts, `{ VALUES ?i { `+strings.Join(imdb, " ")+` } ?item wdt:P345 ?i . }`)
	}
	return "SELECT ?tm ?tv ?i ?kp ?imdb WHERE {\n  " + strings.Join(parts, "\n  UNION ") +
		"\n  ?item wdt:P2603 ?kp .\n  OPTIONAL { ?item wdt:P345 ?imdb . }\n}"
}

// wdRow is one result binding: which key matched, the Kinopoisk id and the
// item's IMDb id (if any).
type wdRow struct {
	tm, tv, i, imdb string
	kp              int
}

type wdStatus int

const (
	wdMiss wdStatus = iota
	wdFound
	wdConflict
)

// pickWD chooses t's Kinopoisk id among the batch rows:
//  1. with an IMDb id: items matched by it (or carrying it) win — exactly one
//     distinct Kinopoisk id, else conflict;
//  2. else items matched by TMDB id (kind-specific property) whose IMDb id
//     does not contradict ours — exactly one distinct id, else conflict.
func pickWD(t WDTitle, rows []wdRow) (int, wdStatus) {
	type agg struct {
		viaTMDB, viaIMDb bool
		imdbs            map[string]bool
	}
	byKP := map[int]*agg{}
	tmdb := strconv.Itoa(t.TMDBID)
	for _, r := range rows {
		viaT := t.TMDBID > 0 && ((t.Kind == "series" && r.tv == tmdb) || (t.Kind == "movie" && r.tm == tmdb))
		viaI := t.IMDbID != "" && strings.EqualFold(r.i, t.IMDbID)
		if !viaT && !viaI {
			continue
		}
		a := byKP[r.kp]
		if a == nil {
			a = &agg{imdbs: map[string]bool{}}
			byKP[r.kp] = a
		}
		a.viaTMDB = a.viaTMDB || viaT
		a.viaIMDb = a.viaIMDb || viaI
		if r.imdb != "" {
			a.imdbs[strings.ToLower(r.imdb)] = true
		}
	}
	one := func(keep func(*agg) bool) (int, int) {
		n, kp := 0, 0
		for id, a := range byKP {
			if keep(a) {
				n++
				kp = id
			}
		}
		return kp, n
	}
	if t.IMDbID != "" {
		kp, n := one(func(a *agg) bool { return a.viaIMDb || a.imdbs[strings.ToLower(t.IMDbID)] })
		switch {
		case n == 1:
			return kp, wdFound
		case n > 1:
			return 0, wdConflict
		}
	}
	contradicted := false
	kp, n := one(func(a *agg) bool {
		if !a.viaTMDB {
			return false
		}
		if t.IMDbID != "" && len(a.imdbs) > 0 && !a.imdbs[strings.ToLower(t.IMDbID)] {
			contradicted = true
			return false
		}
		return true
	})
	switch {
	case n == 1:
		return kp, wdFound
	case n > 1 || contradicted:
		return 0, wdConflict
	}
	return 0, wdMiss
}

// toWDRows keeps the bindings with a numeric Kinopoisk id.
func toWDRows(bindings []map[string]string) []wdRow {
	rows := make([]wdRow, 0, len(bindings))
	for _, b := range bindings {
		kp, err := strconv.Atoi(strings.TrimSpace(b["kp"]))
		if err != nil || kp <= 0 {
			continue // P2603 values are numeric; skip anything odd
		}
		rows = append(rows, wdRow{tm: b["tm"], tv: b["tv"], i: b["i"], imdb: b["imdb"], kp: kp})
	}
	return rows
}

// Select runs one SPARQL query (POST), honoring spacing and back-off, and
// returns the result bindings as variable → value (unbound variables are
// absent). Other modules (internal/awards) share the client, so its
// one-at-a-time spacing and back-off cover all Wikidata traffic.
func (c *WikidataClient) Select(ctx context.Context, q string) ([]map[string]string, error) {
	c.reqMu.Lock()
	defer c.reqMu.Unlock()

	c.mu.Lock()
	now := c.now()
	if now.Before(c.until) {
		c.mu.Unlock()
		return nil, ErrWikidataBackoff
	}
	wait := c.last.Add(c.minGap).Sub(now)
	c.mu.Unlock()
	if wait > 0 {
		if err := c.sleep(ctx, wait); err != nil {
			return nil, err
		}
	}
	c.mu.Lock()
	c.last = c.now()
	c.mu.Unlock()

	rows, retryAfter, err := c.do(ctx, q)
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case err == nil:
		c.backoff, c.lastErr, c.lastOK = 0, nil, c.now()
		return rows, nil
	case ctx.Err() != nil:
		return nil, err
	case errors.Is(err, errWDBadQuery):
		// Our fault (4xx other than 429): don't hammer, but no long pause.
		c.lastErr, c.failedAt = err, c.now()
		c.until = c.now().Add(wikidataBackoffMin)
		return nil, err
	}
	c.backoff = min(max(c.backoff*2, wikidataBackoffMin), wikidataBackoffMax)
	d := max(c.backoff, retryAfter)
	c.until = c.now().Add(d)
	c.lastErr, c.failedAt = err, c.now()
	return nil, err
}

var errWDBadQuery = errors.New("wikidata: query rejected")

func (c *WikidataClient) do(ctx context.Context, q string) ([]map[string]string, time.Duration, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, strings.NewReader(url.Values{"query": {q}}.Encode()))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/sparql-results+json")
	req.Header.Set("User-Agent", wikidataUA)
	resp, err := c.http.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			if ue.Timeout() {
				return nil, 0, errors.New("wikidata: request timed out")
			}
			err = ue.Err
		}
		return nil, 0, fmt.Errorf("wikidata: request failed: %w", err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		return nil, retryAfter(resp.Header.Get("Retry-After"), c.now()), fmt.Errorf("wikidata: HTTP %d", resp.StatusCode)
	default:
		return nil, 0, fmt.Errorf("%w (HTTP %d)", errWDBadQuery, resp.StatusCode)
	}
	var body struct {
		Results struct {
			Bindings []map[string]struct {
				Value string `json:"value"`
			} `json:"bindings"`
		} `json:"results"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, wikidataMaxBody)).Decode(&body); err != nil {
		return nil, 0, errors.New("wikidata: bad JSON response")
	}
	rows := make([]map[string]string, 0, len(body.Results.Bindings))
	for _, b := range body.Results.Bindings {
		m := make(map[string]string, len(b))
		for k, v := range b {
			m[k] = v.Value
		}
		rows = append(rows, m)
	}
	return rows, 0, nil
}

// retryAfter parses seconds or an HTTP date (0 when absent/invalid).
func retryAfter(v string, now time.Time) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if n, err := strconv.Atoi(v); err == nil && n > 0 {
		return min(time.Duration(n)*time.Second, 6*time.Hour)
	}
	if t, err := http.ParseTime(v); err == nil {
		return min(max(t.Sub(now), 0), 6*time.Hour)
	}
	return 0
}
