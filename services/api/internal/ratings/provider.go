package ratings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Provider maps titles to Kinopoisk ids through a keyed API. Every method
// is exactly one HTTP request (the caller charges the daily budget per call).
type Provider interface {
	Name() string
	// ByIMDb finds titles by IMDb id ("tt0133093").
	ByIMDb(ctx context.Context, imdbID string) ([]Candidate, error)
	// ByTMDB finds titles by TMDB id (only when CanTMDB).
	ByTMDB(ctx context.Context, tmdbID int) ([]Candidate, error)
	// ByTitle searches by title around a year (only when CanTitle).
	ByTitle(ctx context.Context, title string, year int) ([]Candidate, error)
	CanTMDB() bool
	CanTitle() bool
	// Quota reports the key's remaining daily requests when the API can
	// tell (ok=false otherwise). It must not spend quota.
	Quota(ctx context.Context) (remaining int, plan string, ok bool, err error)
}

// Candidate is one Kinopoisk title returned by a provider.
type Candidate struct {
	KPID   int
	IMDbID string
	TMDBID int
	// Series is nil when the provider didn't say.
	Series *bool
	Year   int
	Names  []string
}

var (
	// ErrQuota is the provider's "daily/total limit exceeded" (HTTP 402 on
	// the unofficial API, 403 with a limit message on kinopoisk.dev).
	ErrQuota = errors.New("kinopoisk: API quota exceeded")
	// ErrUnauthorized is a missing/invalid key.
	ErrUnauthorized = errors.New("kinopoisk: API key rejected")
)

const maxJSON = 1 << 20

func getJSON(ctx context.Context, client *http.Client, u, key string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return errors.New("kinopoisk: bad request")
	}
	if key != "" {
		req.Header.Set("X-API-KEY", key)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return sanitize(err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return ErrUnauthorized
	case http.StatusPaymentRequired:
		return ErrQuota
	case http.StatusForbidden:
		// kinopoisk.dev answers 403 for an exhausted daily limit; the
		// unofficial API for a blocked/inactive account.
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		if strings.Contains(strings.ToLower(string(b)), "лимит") || strings.Contains(strings.ToLower(string(b)), "limit") {
			return ErrQuota
		}
		return ErrUnauthorized
	case http.StatusNotFound:
		return ErrNotFound
	default:
		return fmt.Errorf("kinopoisk api: unexpected HTTP %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxJSON)).Decode(out); err != nil {
		return errors.New("kinopoisk api: bad JSON response")
	}
	return nil
}

// ---- kinopoiskapiunofficial.tech ----

// Unofficial is kinopoiskapiunofficial.tech (free key: 500 requests/day,
// 20 req/s). Endpoints checked against its OpenAPI spec (2026-10):
//
//	GET /api/v2.2/films?imdbId=tt…                       → {items:[{kinopoiskId, imdbId, nameRu, nameEn, nameOriginal, year, type}]}
//	GET /api/v2.2/films?keyword=…&yearFrom=&yearTo=&order=NUM_VOTE
//	GET /api/v1/api_keys/{key}                           → {dailyQuota:{value, used}, accountType}
type Unofficial struct {
	base, key string
	http      *http.Client
}

func NewUnofficial(base, key string, client *http.Client) *Unofficial {
	return &Unofficial{base: strings.TrimRight(base, "/"), key: key, http: client}
}

func (u *Unofficial) Name() string { return "kinopoiskapiunofficial.tech" }

type unofficialFilms struct {
	Items []struct {
		KinopoiskID  int      `json:"kinopoiskId"`
		IMDbID       *string  `json:"imdbId"`
		NameRu       *string  `json:"nameRu"`
		NameEn       *string  `json:"nameEn"`
		NameOriginal *string  `json:"nameOriginal"`
		Year         *float64 `json:"year"`
		Type         string   `json:"type"`
	} `json:"items"`
}

func (u *Unofficial) films(ctx context.Context, q url.Values) ([]Candidate, error) {
	var res unofficialFilms
	if err := getJSON(ctx, u.http, u.base+"/api/v2.2/films?"+q.Encode(), u.key, &res); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]Candidate, 0, len(res.Items))
	for _, it := range res.Items {
		if it.KinopoiskID <= 0 {
			continue
		}
		c := Candidate{KPID: it.KinopoiskID, IMDbID: deref(it.IMDbID), Series: unofficialSeries(it.Type),
			Names: nonEmpty(deref(it.NameRu), deref(it.NameEn), deref(it.NameOriginal))}
		if it.Year != nil {
			c.Year = int(*it.Year)
		}
		out = append(out, c)
	}
	return out, nil
}

// unofficialSeries maps FILM, TV_SHOW, VIDEO, MINI_SERIES, TV_SERIES, UNKNOWN.
func unofficialSeries(t string) *bool {
	switch t {
	case "FILM", "VIDEO":
		return ptr(false)
	case "TV_SERIES", "MINI_SERIES", "TV_SHOW":
		return ptr(true)
	}
	return nil
}

func (u *Unofficial) ByIMDb(ctx context.Context, imdbID string) ([]Candidate, error) {
	return u.films(ctx, url.Values{"imdbId": {imdbID}})
}

func (u *Unofficial) CanTMDB() bool  { return false }
func (u *Unofficial) CanTitle() bool { return true }

func (u *Unofficial) ByTMDB(context.Context, int) ([]Candidate, error) { return nil, nil }

func (u *Unofficial) ByTitle(ctx context.Context, title string, year int) ([]Candidate, error) {
	q := url.Values{"keyword": {title}, "order": {"NUM_VOTE"}}
	if year > 0 {
		q.Set("yearFrom", strconv.Itoa(year-1))
		q.Set("yearTo", strconv.Itoa(year+1))
	}
	return u.films(ctx, q)
}

func (u *Unofficial) Quota(ctx context.Context) (int, string, bool, error) {
	var res struct {
		DailyQuota  struct{ Value, Used int } `json:"dailyQuota"`
		AccountType string                    `json:"accountType"`
	}
	if err := getJSON(ctx, u.http, u.base+"/api/v1/api_keys/"+url.PathEscape(u.key), u.key, &res); err != nil {
		if errors.Is(err, ErrNotFound) {
			return 0, "", false, ErrUnauthorized
		}
		return 0, "", false, err
	}
	return max(res.DailyQuota.Value-res.DailyQuota.Used, 0), res.AccountType, true, nil
}

// ---- kinopoisk.dev (now poiskkino.dev) ----

// Dev is kinopoisk.dev / poiskkino.dev (free key via Telegram
// @kinopoiskdev_bot; small daily limit). Checked against its OpenAPI spec
// (2026-10; api.kinopoisk.dev 301-redirects to api.poiskkino.dev):
//
//	GET /v1.5/movie?externalId.imdb=tt…   → {docs:[{id, name, enName, alternativeName, year, isSeries, externalId:{imdb,tmdb}}]}
//	GET /v1.5/movie?externalId.tmdb=603
type Dev struct {
	base, key string
	http      *http.Client
}

func NewDev(base, key string, client *http.Client) *Dev {
	return &Dev{base: strings.TrimRight(base, "/"), key: key, http: client}
}

func (d *Dev) Name() string { return "kinopoisk.dev" }

var devFields = []string{"id", "name", "enName", "alternativeName", "year", "isSeries", "externalId"}

func (d *Dev) movies(ctx context.Context, q url.Values) ([]Candidate, error) {
	q.Set("limit", "10")
	q["selectFields"] = devFields
	var res struct {
		Docs []struct {
			ID              int      `json:"id"`
			Name            *string  `json:"name"`
			EnName          *string  `json:"enName"`
			AlternativeName *string  `json:"alternativeName"`
			Year            *float64 `json:"year"`
			IsSeries        *bool    `json:"isSeries"`
			ExternalID      *struct {
				IMDb *string  `json:"imdb"`
				TMDB *float64 `json:"tmdb"`
			} `json:"externalId"`
		} `json:"docs"`
	}
	if err := getJSON(ctx, d.http, d.base+"/v1.5/movie?"+q.Encode(), d.key, &res); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]Candidate, 0, len(res.Docs))
	for _, doc := range res.Docs {
		if doc.ID <= 0 {
			continue
		}
		c := Candidate{KPID: doc.ID, Series: doc.IsSeries,
			Names: nonEmpty(deref(doc.Name), deref(doc.EnName), deref(doc.AlternativeName))}
		if doc.Year != nil {
			c.Year = int(*doc.Year)
		}
		if doc.ExternalID != nil {
			c.IMDbID = deref(doc.ExternalID.IMDb)
			if doc.ExternalID.TMDB != nil {
				c.TMDBID = int(*doc.ExternalID.TMDB)
			}
		}
		out = append(out, c)
	}
	return out, nil
}

func (d *Dev) ByIMDb(ctx context.Context, imdbID string) ([]Candidate, error) {
	return d.movies(ctx, url.Values{"externalId.imdb": {imdbID}})
}

func (d *Dev) CanTMDB() bool  { return true }
func (d *Dev) CanTitle() bool { return false }

func (d *Dev) ByTMDB(ctx context.Context, tmdbID int) ([]Candidate, error) {
	return d.movies(ctx, url.Values{"externalId.tmdb": {strconv.Itoa(tmdbID)}})
}

func (d *Dev) ByTitle(context.Context, string, int) ([]Candidate, error) { return nil, nil }

func (d *Dev) Quota(context.Context) (int, string, bool, error) { return 0, "", false, nil }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func nonEmpty(vals ...string) []string {
	var out []string
	for _, v := range vals {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func ptr[T any](v T) *T { return &v }
