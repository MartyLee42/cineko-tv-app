package main

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
	"sort"
	"strings"
	"time"
)

// In-app chords/tabs from Ultimate Guitar (Songsterr refuses the server).
// Their pages embed the data as JSON in <div class="js-store" data-content>.

var jsStoreRe = regexp.MustCompile(`class="js-store" data-content="([^"]+)"`)

type TabRef struct {
	ID     int64   `json:"id"`
	Song   string  `json:"song"`
	Artist string  `json:"artist"`
	Type   string  `json:"type"`
	Rating float64 `json:"rating"`
	Votes  int     `json:"votes"`
	URL    string  `json:"url"`
}

type TabSheet struct {
	TabRef
	Tuning  string `json:"tuning,omitempty"`
	Capo    int    `json:"capo,omitempty"`
	Content string `json:"content"`
}

func (a *App) ugGet(ctx context.Context, u string) (map[string]any, error) {
	key := "ug|" + u
	if b, ok := a.lyrics.get(key); ok {
		var d map[string]any
		if json.Unmarshal(b, &d) == nil {
			return d, nil
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
	req.Header.Set("Accept-Language", "ru,en;q=0.8")
	resp, err := a.ext.Do(req)
	if err != nil {
		return nil, fmt.Errorf("tabs: %w", shortErr(err))
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tabs: HTTP %d", resp.StatusCode)
	}
	m := jsStoreRe.FindSubmatch(body)
	if m == nil {
		return nil, errors.New("tabs: page format changed")
	}
	raw := html.UnescapeString(string(m[1]))
	var d map[string]any
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		return nil, errors.New("tabs: bad page data")
	}
	pageData, _ := dig(d, "store", "page", "data").(map[string]any)
	if pageData == nil {
		return nil, errors.New("tabs: no data")
	}
	if b, err := json.Marshal(pageData); err == nil {
		a.lyrics.set(key, b, 12*time.Hour)
	}
	return pageData, nil
}

func dig(v any, keys ...string) any {
	for _, k := range keys {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[k]
	}
	return v
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

// Guitar tabs first (the household's preference), then bass, chords, ukulele.
var tabTypes = map[string]int{"Tabs": 0, "Bass Tabs": 1, "Chords": 2, "Ukulele Chords": 3}

// hTabsSearch: ?artist=&title= (or ?q=). Only versions of that very song by
// that artist are kept; tabs before chords, then by votes.
func (a *App) hTabsSearch(w http.ResponseWriter, r *http.Request, u *User) error {
	qv := r.URL.Query()
	artist := strings.TrimSpace(strings.Split(qv.Get("artist"), ",")[0])
	title := strings.TrimSpace(cleanTitle(qv.Get("title")))
	q := strings.TrimSpace(qv.Get("q"))
	if title != "" {
		q = strings.TrimSpace(artist + " " + title)
	}
	if q == "" {
		return errStatus(400, "bad_request", "Пустой запрос")
	}
	d, err := a.ugGet(r.Context(), "https://www.ultimate-guitar.com/search.php?search_type=title&value="+url.QueryEscape(q))
	if err != nil {
		return err
	}
	list, _ := d["results"].([]any)
	all := []TabRef{}
	for _, it := range list {
		m, _ := it.(map[string]any)
		typ := str(m["type"])
		if _, ok := tabTypes[typ]; !ok || m["id"] == nil {
			continue // official/pro versions need UG's app
		}
		all = append(all, TabRef{ID: int64(num(m["id"])), Song: str(m["song_name"]), Artist: str(m["artist_name"]), Type: typ,
			Rating: num(m["rating"]), Votes: int(num(m["votes"])), URL: str(m["tab_url"])})
	}
	out := all
	if title != "" {
		nt, na := normalize(title), normalize(artist)
		songOK := func(t TabRef) bool {
			ns := normalize(cleanTitle(t.Song))
			return ns == nt || (len(nt) > 3 && strings.Contains(ns, nt)) || (len(ns) > 3 && strings.Contains(nt, ns))
		}
		artistOK := func(t TabRef) bool {
			nb := normalize(t.Artist)
			return na == "" || nb == na || strings.Contains(nb, na) || strings.Contains(na, nb)
		}
		exact := []TabRef{}
		for _, t := range all {
			if songOK(t) && artistOK(t) {
				exact = append(exact, t)
			}
		}
		out = exact // nothing for this song by this artist → empty, never a different song
	}
	sort.SliceStable(out, func(i, j int) bool {
		if tabTypes[out[i].Type] != tabTypes[out[j].Type] {
			return tabTypes[out[i].Type] < tabTypes[out[j].Type]
		}
		return out[i].Votes > out[j].Votes
	})
	writeJSON(w, 200, out)
	return nil
}

func (a *App) hTabSheet(w http.ResponseWriter, r *http.Request, u *User) error {
	raw := r.URL.Query().Get("url")
	pu, err := url.Parse(raw)
	if err != nil || pu.Scheme != "https" || pu.Host != "tabs.ultimate-guitar.com" || !strings.HasPrefix(pu.Path, "/tab/") {
		return errStatus(400, "bad_request", "Недопустимая ссылка")
	}
	d, err := a.ugGet(r.Context(), pu.String())
	if err != nil {
		return err
	}
	tab, _ := d["tab"].(map[string]any)
	view, _ := d["tab_view"].(map[string]any)
	content := str(dig(view, "wiki_tab", "content"))
	if content == "" {
		return errStatus(404, "not_found", "Табулатура недоступна")
	}
	out := TabSheet{TabRef: TabRef{ID: int64(num(tab["id"])), Song: str(tab["song_name"]), Artist: str(tab["artist_name"]),
		Type: str(tab["type"]), Rating: num(tab["rating"]), Votes: int(num(tab["votes"])), URL: pu.String()}, Content: content}
	out.Tuning = str(dig(view, "meta", "tuning", "value"))
	out.Capo = int(num(dig(view, "meta", "capo")))
	writeJSON(w, 200, out)
	return nil
}
