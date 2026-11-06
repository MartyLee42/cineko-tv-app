package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"martytv/api/internal/integrations/tmdb"
)

// Person is an actor's (or director's) page: who they are and the films and
// series they were in.
type Person struct {
	TMDBID       int     `json:"tmdb_id"`
	Name         string  `json:"name"`
	ProfilePath  *string `json:"profile_path"`
	Biography    string  `json:"biography"`
	Birthday     *string `json:"birthday"`
	Deathday     *string `json:"deathday"`
	PlaceOfBirth *string `json:"place_of_birth"`
	// KnownFor is TMDB's known_for_department ("Acting", "Directing"…).
	KnownFor string         `json:"known_for_department"`
	Credits  []PersonCredit `json:"credits"`
}

// PersonCredit is one title with what the person did there: the character
// played, or jobs ("Director").
type PersonCredit struct {
	Media MediaSummary `json:"media"`
	Role  string       `json:"role"`
	// Crew: behind the camera only (directed / wrote), not acted.
	Crew bool `json:"crew"`
}

const maxPersonCredits = 150

// Talk shows, news and reality: guest spots, not roles.
var skipGenres = []int{10763, 10764, 10767}

// "Self", "Himself", "Herself (archive footage)", «Камео»…: appearances as oneself.
var selfRole = regexp.MustCompile(`(?i)^\s*(self|himself|herself|themselves|сам|сама|себя)\b`)

var personJobs = map[string]bool{"Director": true, "Screenplay": true, "Writer": true, "Creator": true}

type tmdbPerson struct {
	ID                 int     `json:"id"`
	Name               string  `json:"name"`
	ProfilePath        *string `json:"profile_path"`
	Biography          string  `json:"biography"`
	Birthday           *string `json:"birthday"`
	Deathday           *string `json:"deathday"`
	PlaceOfBirth       *string `json:"place_of_birth"`
	KnownForDepartment string  `json:"known_for_department"`
	CombinedCredits    struct {
		Cast []struct {
			tmdb.ListItem
			Character string `json:"character"`
		} `json:"cast"`
		Crew []struct {
			tmdb.ListItem
			Job string `json:"job"`
		} `json:"crew"`
	} `json:"combined_credits"`
}

// Person loads /person/{id} with combined_credits. Credits are sorted by
// popularity (best known first); talk shows and playing oneself are left out.
func (s *Service) Person(ctx context.Context, tmdbID int, lang string) (*Person, error) {
	p, fresh, err := s.fetchPerson(ctx, tmdbID, lang)
	if err != nil {
		return nil, err
	}
	bio := p.Biography
	if bio == "" && lang != "en" { // many people have no Russian biography
		if en, _, err := s.fetchPerson(ctx, tmdbID, "en"); err == nil {
			bio = en.Biography
		}
	}

	type acc struct {
		item  tmdb.ListItem
		roles []string
		acted bool
	}
	byKey := map[mediaKey]*acc{}
	var order []mediaKey
	add := func(it tmdb.ListItem, role string, acted bool) {
		kind := tmdb.Kind(it.MediaType)
		if kind == "" || it.ID <= 0 || slices.ContainsFunc(it.GenreIDs, func(g int) bool { return slices.Contains(skipGenres, g) }) {
			return
		}
		k := mediaKey{kind, it.ID}
		a := byKey[k]
		if a == nil {
			a = &acc{item: it}
			byKey[k] = a
			order = append(order, k)
		}
		a.acted = a.acted || acted
		if role = strings.TrimSpace(role); role != "" && !slices.Contains(a.roles, role) {
			a.roles = append(a.roles, role)
		}
	}
	for _, c := range p.CombinedCredits.Cast {
		if selfRole.MatchString(c.Character) {
			continue
		}
		add(c.ListItem, c.Character, true)
	}
	for _, c := range p.CombinedCredits.Crew {
		if personJobs[c.Job] {
			add(c.ListItem, c.Job, false)
		}
	}
	// Drop obscure entries (no poster and no votes): mostly unreleased stubs.
	order = slices.DeleteFunc(order, func(k mediaKey) bool {
		it := byKey[k].item
		return it.PosterPath == nil && it.VoteCount == 0
	})
	slices.SortStableFunc(order, func(a, b mediaKey) int {
		pa, pb := byKey[a].item.Popularity, byKey[b].item.Popularity
		switch {
		case pa > pb:
			return -1
		case pa < pb:
			return 1
		}
		return 0
	})
	if len(order) > maxPersonCredits {
		order = order[:maxPersonCredits]
	}
	items := make([]tmdb.ListItem, len(order))
	for i, k := range order {
		items[i] = byKey[k].item
	}
	sums, err := s.summaries(ctx, lang, items, "", fresh)
	if err != nil {
		return nil, err
	}
	out := &Person{
		TMDBID: p.ID, Name: p.Name, ProfilePath: emptyNil(p.ProfilePath), Biography: bio,
		Birthday: emptyNil(p.Birthday), Deathday: emptyNil(p.Deathday), PlaceOfBirth: emptyNil(p.PlaceOfBirth),
		KnownFor: p.KnownForDepartment, Credits: make([]PersonCredit, 0, len(sums)),
	}
	for i, m := range sums {
		a := byKey[order[i]]
		out.Credits = append(out.Credits, PersonCredit{Media: m, Role: strings.Join(a.roles, ", "), Crew: !a.acted})
	}
	return out, nil
}

func (s *Service) fetchPerson(ctx context.Context, tmdbID int, lang string) (*tmdbPerson, bool, error) {
	if tmdbID <= 0 {
		return nil, false, ErrNotFound
	}
	q := url.Values{"language": {tmdb.Language(lang)}, "append_to_response": {"combined_credits"}}
	body, fresh, err := s.fetch(ctx, fmt.Sprintf("/person/%d", tmdbID), q, ttlRelated, false)
	if errors.Is(err, tmdb.ErrNotFound) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	var p tmdbPerson
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, false, fmt.Errorf("%w: decode: %v", ErrUpstream, err)
	}
	return &p, fresh, nil
}
