package segments

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const maxBody = 256 << 10

func getJSON(ctx context.Context, c *http.Client, u string, v any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Cineko (self-hosted media center)")
	resp, err := c.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return resp.StatusCode, err
	}
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, nil
	}
	return resp.StatusCode, json.Unmarshal(body, v)
}

// ---- TheIntroDB ----

// TheIntroDB: GET {base}/v2/media?tmdb_id=&season=&episode= →
// {"intro":[{"start_ms":…,"end_ms":…}],"recap":[…],"credits":[…],"preview":[…]};
// a null start is the file's start, a null end its end; 404 = unknown.
type TheIntroDB struct {
	Base string // https://api.theintrodb.org
	HTTP *http.Client
}

func (TheIntroDB) Name() string { return "theintrodb" }

type tidbRange struct {
	StartMS *float64 `json:"start_ms"`
	EndMS   *float64 `json:"end_ms"`
}

func (p TheIntroDB) Fetch(ctx context.Context, q Query) ([]Segment, error) {
	if q.TMDBID <= 0 {
		return nil, ErrNotFound
	}
	v := url.Values{"tmdb_id": {strconv.Itoa(q.TMDBID)}}
	if !q.Movie {
		v.Set("season", strconv.Itoa(q.Season))
		v.Set("episode", strconv.Itoa(q.Episode))
	}
	var body map[string]json.RawMessage
	code, err := getJSON(ctx, p.HTTP, strings.TrimRight(p.Base, "/")+"/v2/media?"+v.Encode(), &body)
	if err != nil {
		return nil, err
	}
	if code == http.StatusNotFound || code == http.StatusBadRequest {
		return nil, ErrNotFound
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("theintrodb: HTTP %d", code)
	}
	var out []Segment
	// preview follows the credits: «Следующая серия» covers both.
	for _, f := range []struct{ field, kind string }{{"intro", Opening}, {"recap", Recap}, {"credits", Ending}, {"preview", Ending}} {
		var rs []tidbRange
		if raw, ok := body[f.field]; !ok || json.Unmarshal(raw, &rs) != nil {
			continue
		}
		for _, r := range rs {
			sg := Segment{Kind: f.kind, Source: "theintrodb"}
			if r.StartMS != nil {
				sg.Start = *r.StartMS / 1000
			}
			if r.EndMS != nil {
				if sg.End = *r.EndMS / 1000; sg.End <= sg.Start {
					continue // e.g. a {0, 0} "no recap" entry
				}
			}
			out = append(out, sg)
			break // one range per kind
		}
	}
	out = Merge(out)
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out, nil
}

// ---- IntroDB ----

// IntroDB: GET {base}/segments?imdb_id=&season=&episode= (series only) →
// {"intro":{"start_ms":…,"end_ms":…}|null,"recap":…,"outro":…}.
type IntroDB struct {
	Base string // https://api.introdb.app
	HTTP *http.Client
}

func (IntroDB) Name() string { return "introdb" }

type introdbRange struct {
	StartMS *float64 `json:"start_ms"`
	EndMS   *float64 `json:"end_ms"`
}

var imdbRe = regexp.MustCompile(`^tt\d{5,10}$`)

func (p IntroDB) Fetch(ctx context.Context, q Query) ([]Segment, error) {
	if q.Movie || !imdbRe.MatchString(q.IMDbID) || q.Episode <= 0 {
		return nil, ErrNotFound
	}
	v := url.Values{"imdb_id": {q.IMDbID}, "season": {strconv.Itoa(q.Season)}, "episode": {strconv.Itoa(q.Episode)}}
	var body struct {
		Intro *introdbRange `json:"intro"`
		Recap *introdbRange `json:"recap"`
		Outro *introdbRange `json:"outro"`
	}
	code, err := getJSON(ctx, p.HTTP, strings.TrimRight(p.Base, "/")+"/segments?"+v.Encode(), &body)
	if err != nil {
		return nil, err
	}
	if code == http.StatusNotFound || code == http.StatusBadRequest {
		return nil, ErrNotFound
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("introdb: HTTP %d", code)
	}
	var out []Segment
	for _, f := range []struct {
		r    *introdbRange
		kind string
	}{{body.Intro, Opening}, {body.Recap, Recap}, {body.Outro, Ending}} {
		if f.r == nil || f.r.StartMS == nil {
			continue
		}
		sg := Segment{Kind: f.kind, Start: *f.r.StartMS / 1000, Source: "introdb"}
		if f.r.EndMS != nil {
			sg.End = *f.r.EndMS / 1000
		}
		out = append(out, sg)
	}
	out = Merge(out)
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out, nil
}

// ---- chapters ----

// Chapter is a chapter of the file (ffprobe -show_chapters).
type Chapter struct {
	Start, End float64
	Title      string
}

var (
	chOpening = regexp.MustCompile(`(?i)^(op|op\s*\d*|opening( credits| theme)?|intro(duction)?|title sequence|main title|opening song|заставка|вступление|опенинг|интро)$`)
	chRecap   = regexp.MustCompile(`(?i)^(recap|previously( on.*)?|ранее( в сериале)?|в предыдущих сериях|предыдущие серии|пересказ)$`)
	chEnding  = regexp.MustCompile(`(?i)^(ed|ed\s*\d*|ending( credits| theme)?|end credits|credits|outro|closing credits|ending song|preview|next episode( preview)?|титры|финальные титры|эндинг|аутро|анонс( следующей серии)?)$`)
)

// FromChapters turns titled chapters into segments ("Opening", "OP",
// «Заставка», "Credits", «Титры»…). Untitled ("Chapter 1") files give none.
// Adjacent chapters of the same kind (credits + preview) join.
func FromChapters(chs []Chapter) []Segment {
	var out []Segment
	for _, c := range chs {
		t := strings.TrimSpace(strings.Trim(c.Title, "-–—:·. "))
		var kind string
		switch {
		case chOpening.MatchString(t):
			kind = Opening
		case chRecap.MatchString(t):
			kind = Recap
		case chEnding.MatchString(t):
			kind = Ending
		default:
			continue
		}
		if c.End <= c.Start {
			continue
		}
		if n := len(out); n > 0 && out[n-1].Kind == kind && c.Start-out[n-1].End < 1 {
			out[n-1].End = c.End
			continue
		}
		out = append(out, Segment{Kind: kind, Start: c.Start, End: c.End, Source: "chapters"})
	}
	return Merge(out)
}
