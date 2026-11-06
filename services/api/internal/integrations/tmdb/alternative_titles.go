package tmdb

import (
	"context"
	"encoding/json"
	"strconv"
)

// AlternativeTitle is one entry of /movie|tv/{id}/alternative_titles.
type AlternativeTitle struct {
	Country string `json:"iso_3166_1"`
	Title   string `json:"title"`
	Type    string `json:"type"`
}

// AlternativeTitles returns a title's alternative titles in every country.
// kind is a Cineko kind ("movie" or "series"). TMDB names the list
// "titles" for movies and "results" for tv.
func (c *Client) AlternativeTitles(ctx context.Context, kind string, id int) ([]AlternativeTitle, error) {
	body, err := c.Get(ctx, "/"+MediaType(kind)+"/"+strconv.Itoa(id)+"/alternative_titles", nil)
	if err != nil {
		return nil, err
	}
	var r struct {
		Titles  []AlternativeTitle `json:"titles"`
		Results []AlternativeTitle `json:"results"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, err
	}
	return append(r.Titles, r.Results...), nil
}
