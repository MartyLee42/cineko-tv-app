package ratings

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// Values are one title's ratings. Nil means unknown.
type Values struct {
	KP        *float64
	KPVotes   *int
	IMDb      *float64
	IMDbVotes *int
}

// ErrNotFound is a Kinopoisk 404 (unknown id / no rating page).
var ErrNotFound = errors.New("kinopoisk: not found")

// ParseRatingXML parses rating.kinopoisk.ru/<id>.xml (verified 2026-10):
//
//	<?xml version="1.0" encoding="WINDOWS-1251" standalone="yes"?>
//	<rating><kp_rating num_vote="817709">8.501</kp_rating><imdb_rating num_vote="2200000">8.7</imdb_rating></rating>
//
// Either element may be missing. A rating with no votes (or 0) is unknown.
func ParseRatingXML(b []byte) (Values, error) {
	var doc struct {
		XMLName xml.Name  `xml:"rating"`
		KP      *ratingEl `xml:"kp_rating"`
		IMDb    *ratingEl `xml:"imdb_rating"`
	}
	dec := xml.NewDecoder(bytes.NewReader(b))
	// The document declares windows-1251 but carries only ASCII digits.
	dec.CharsetReader = func(_ string, r io.Reader) (io.Reader, error) { return r, nil }
	if err := dec.Decode(&doc); err != nil {
		return Values{}, fmt.Errorf("kinopoisk: bad rating xml: %w", err)
	}
	var v Values
	v.KP, v.KPVotes = doc.KP.values()
	v.IMDb, v.IMDbVotes = doc.IMDb.values()
	return v, nil
}

type ratingEl struct {
	Votes string `xml:"num_vote,attr"`
	Value string `xml:",chardata"`
}

func (e *ratingEl) values() (*float64, *int) {
	if e == nil {
		return nil, nil
	}
	r, err := strconv.ParseFloat(strings.TrimSpace(e.Value), 64)
	if err != nil || r <= 0 || r > 10 {
		return nil, nil
	}
	var votes *int
	if n, err := strconv.Atoi(strings.TrimSpace(e.Votes)); err == nil {
		if n <= 0 {
			return nil, nil
		}
		votes = &n
	}
	return &r, votes
}

// RatingClient reads rating.kinopoisk.ru (no key needed).
type RatingClient struct {
	base string
	http *http.Client
}

func NewRatingClient(base string, client *http.Client) *RatingClient {
	return &RatingClient{base: strings.TrimRight(base, "/"), http: client}
}

// Fetch returns the ratings of a Kinopoisk id. Unknown ids answer 404 (HTML);
// some ids answer 200 with an image, which is treated as not found too.
func (c *RatingClient) Fetch(ctx context.Context, kpID int) (Values, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/"+strconv.Itoa(kpID)+".xml", nil)
	if err != nil {
		return Values{}, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return Values{}, sanitize(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return Values{}, sanitize(err)
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return Values{}, ErrNotFound
	case resp.StatusCode != http.StatusOK:
		return Values{}, fmt.Errorf("kinopoisk rating: unexpected HTTP %d", resp.StatusCode)
	case !strings.Contains(resp.Header.Get("Content-Type"), "xml") && !bytes.HasPrefix(bytes.TrimSpace(body), []byte("<?xml")):
		return Values{}, ErrNotFound
	}
	return ParseRatingXML(body)
}
