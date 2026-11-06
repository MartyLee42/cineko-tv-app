package foryou

import (
	"context"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"martytv/api/internal/catalog"
)

// ExploreTile is the contract's ExploreTile.
type ExploreTile struct {
	ID           string  `json:"id"`
	Kind         string  `json:"kind"`
	Title        string  `json:"title"`
	Subtitle     *string `json:"subtitle"`
	Emoji        *string `json:"emoji"`
	ImagePath    *string `json:"image_path"`
	CollectionID *string `json:"collection_id"`
	// CuratedID / Progress: kind curated (internal/curated).
	CuratedID *string        `json:"curated_id,omitempty"`
	Progress  *string        `json:"progress,omitempty"`
	Discover  map[string]any `json:"discover"`
}

// ExploreSection is the contract's ExploreSection.
type ExploreSection struct {
	ID    string        `json:"id"`
	Kind  string        `json:"kind"`
	Title string        `json:"title"`
	Tiles []ExploreTile `json:"tiles"`
}

func strp(s string) *string { return &s }

// byTaste orders keys: positive affinities first (strongest first), then
// the rest in their given order.
func byTaste(keys []string, aff []Affinity) []string {
	score := map[string]float64{}
	for _, a := range aff {
		score[a.Key] = a.Score
	}
	out := slices.Clone(keys)
	slices.SortStableFunc(out, func(a, b string) int {
		sa, sb := max(score[a], 0), max(score[b], 0)
		switch {
		case sa > sb:
			return -1
		case sa < sb:
			return 1
		}
		return 0
	})
	return out
}

// Explore is GET /foryou/explore.
func (s *Service) Explore(ctx context.Context, profileID, lang string) ([]ExploreSection, error) {
	t, _, err := s.loadTaste(ctx, profileID)
	if err != nil {
		return nil, err
	}
	if t == nil {
		if t, _, err = s.computeTaste(ctx, profileID); err != nil {
			return nil, err
		}
	}
	var sections []ExploreSection

	moods := ExploreSection{ID: "moods", Kind: "moods", Title: tr(lang, "Под настроение", "By mood")}
	for _, m := range Moods {
		// Moods use OR-ed genres, which /catalog/discover can't express.
		moods.Tiles = append(moods.Tiles, ExploreTile{ID: "mood:" + m.Key, Kind: "mood", Title: tr(lang, m.RU, m.EN), Emoji: strp(m.Emoji)})
	}
	sections = append(sections, moods)

	decades := ExploreSection{ID: "decades", Kind: "decades", Title: tr(lang, "По десятилетиям", "By decade")}
	var decKeys []string
	for d := s.now().Year() / 10 * 10; d >= 1950; d -= 10 {
		decKeys = append(decKeys, strconv.Itoa(d))
	}
	for _, k := range byTaste(decKeys, t.Decades) {
		d, _ := strconv.Atoi(k)
		decades.Tiles = append(decades.Tiles, ExploreTile{ID: "decade:" + k, Kind: "decade", Title: decadeName(lang, d),
			Discover: map[string]any{"kind": "movie", "year_from": d, "year_to": d + 9, "sort": "rating"}})
	}
	sections = append(sections, decades)

	langs := ExploreSection{ID: "countries", Kind: "countries", Title: tr(lang, "Страны и языки", "Countries & languages")}
	langKeys := slices.Clone(exploreLanguages)
	for _, a := range t.Languages {
		if a.Score > 0.2 && !slices.Contains(langKeys, a.Key) && len(langKeys) < 16 {
			langKeys = append(langKeys, a.Key)
		}
	}
	for _, k := range byTaste(langKeys, t.Languages) {
		langs.Tiles = append(langs.Tiles, ExploreTile{ID: "lang:" + k, Kind: "language", Title: exploreLanguageTitle(lang, k),
			Discover: map[string]any{"kind": "movie", "original_language": k, "sort": "rating"}})
	}
	sections = append(sections, langs)

	genres := ExploreSection{ID: "genres", Kind: "genres", Title: tr(lang, "Лучшее по жанрам", "Best by genre")}
	names := s.genreNamesFor(ctx, lang)
	var gKeys []string
	for _, g := range exploreGenres {
		gKeys = append(gKeys, strconv.Itoa(g))
	}
	for _, k := range byTaste(gKeys, t.Genres) {
		g, _ := strconv.Atoi(k)
		name := capitalize(genreName(names, lang, g))
		genres.Tiles = append(genres.Tiles, ExploreTile{ID: "genre:" + k, Kind: "genre", Title: name,
			Discover: map[string]any{"kind": "movie", "genres": k, "sort": "rating"}})
	}
	sections = append(sections, genres)

	kws := ExploreSection{ID: "keywords", Kind: "keywords", Title: tr(lang, "Тематические подборки", "Themes")}
	for _, k := range keywordTiles {
		kws.Tiles = append(kws.Tiles, ExploreTile{ID: "kw:" + strconv.Itoa(k.ID), Kind: "keyword", Title: tr(lang, k.RU, k.EN), Emoji: strp(k.Emoji)})
	}
	sections = append(sections, kws)

	cols, err := s.Collections(ctx, profileID, lang)
	if err != nil {
		return nil, err
	}
	if len(cols) > 0 {
		ai := ExploreSection{ID: "collections", Kind: "collections", Title: tr(lang, "Подборки дня", "Collections of the day")}
		for _, c := range cols {
			tile := ExploreTile{ID: "collection:" + c.ID, Kind: "collection", Title: c.Title, CollectionID: strp(c.ID)}
			if c.Description != "" {
				tile.Subtitle = strp(c.Description)
			}
			for _, m := range c.Items {
				if m.BackdropPath != nil {
					tile.ImagePath = m.BackdropPath
					break
				}
			}
			ai.Tiles = append(ai.Tiles, tile)
		}
		sections = append([]ExploreSection{ai}, sections...)
	}
	counts := s.fillTileImages(ctx, profileID, lang, s.minVotes(ctx, profileID), sections)
	sections = dropEmptyTiles(sections, counts)
	// «Подборки» (internal/curated) right after the AI «Подборки дня».
	cur, err := s.curatedSection(ctx, profileID, lang)
	if err != nil {
		s.log.WarnContext(ctx, "foryou: curated section failed", "err", err)
	} else if cur != nil {
		at := 0
		if len(sections) > 0 && sections[0].ID == "collections" {
			at = 1
		}
		sections = append(sections[:at:at], append([]ExploreSection{*cur}, sections[at:]...)...)
	}
	return sections, nil
}

func capitalize(s string) string {
	r := []rune(s)
	if len(r) == 0 {
		return s
	}
	return strings.ToUpper(string(r[0])) + string(r[1:])
}

// BrowsePage is the contract's ForYouBrowsePage.
type BrowsePage struct {
	catalog.MediaPage
	Tile  string `json:"tile"`
	Title string `json:"title"`
}

var tileRe = regexp.MustCompile(`^(mood|decade|lang|genre|kw|collection|curated):([a-z0-9-]{1,64})$`)

// errBadTile is a 422 for an unknown tile.
type errBadTile struct{}

func (errBadTile) Error() string { return "unknown tile" }

// Browse is GET /foryou/browse: one page of a tile, with the profile's
// filters applied and `me` annotated.
func (s *Service) Browse(ctx context.Context, profileID, tile, kind, lang string, page int) (*BrowsePage, error) {
	m := tileRe.FindStringSubmatch(tile)
	if m == nil {
		return nil, errBadTile{}
	}
	typ, key := m[1], m[2]
	if kind == "" {
		kind = "movie"
	}
	// Vote floors follow the profile's min_votes (prefs.go).
	mv := s.minVotes(ctx, profileID)
	vc := func(n int) *int { n = votesFloor(n, mv); return &n }
	vr := func(n int) *int { n = ratedVotesFloor(n, mv); return &n }
	p := catalog.DiscoverParams{Kind: kind, Page: page, Lang: lang, Sort: "popularity"}
	var title string
	switch typ {
	case "curated":
		return s.browseCurated(ctx, profileID, tile, key, lang)
	case "collection":
		c, err := s.CollectionByID(ctx, key, profileID, lang)
		if err != nil {
			return nil, err
		}
		return &BrowsePage{MediaPage: catalog.MediaPage{Items: c.Items, Page: 1, TotalPages: 1, TotalResults: len(c.Items)}, Tile: tile, Title: c.Title}, nil
	case "mood":
		md := moodByKey(key)
		if md == nil {
			return nil, errBadTile{}
		}
		title = tr(lang, md.RU, md.EN)
		p.AnyGenres, p.WithoutGenres = genresFor(kind, md.Genres), genresFor(kind, md.Without)
		p.VoteCountMin = vc(300)
		r := 6.3
		p.RatingMin = &r
	case "decade":
		d, err := strconv.Atoi(key)
		if err != nil || d < 1900 || d > 2090 || d%10 != 0 {
			return nil, errBadTile{}
		}
		title = decadeName(lang, d)
		from, to := d, d+9
		p.YearFrom, p.YearTo, p.Sort, p.VoteCountMin = &from, &to, "rating", vr(500)
	case "lang":
		if len(key) != 2 {
			return nil, errBadTile{}
		}
		title = exploreLanguageTitle(lang, key)
		p.OriginalLanguage, p.Sort, p.VoteCountMin = key, "rating", vr(300)
	case "genre":
		g, err := strconv.Atoi(key)
		if err != nil {
			return nil, errBadTile{}
		}
		title = genreName(s.genreNamesFor(ctx, lang), lang, g)
		p.Genres, p.Sort, p.VoteCountMin = genresFor(kind, []int{g}), "rating", vr(1000)
		if len(p.Genres) == 0 {
			return &BrowsePage{MediaPage: catalog.MediaPage{Items: []catalog.MediaSummary{}, Page: page}, Tile: tile, Title: title}, nil
		}
	case "kw":
		k, err := strconv.Atoi(key)
		if err != nil {
			return nil, errBadTile{}
		}
		title = key
		p.WithKeywords, p.VoteCountMin = []int{k}, vc(100)
		if x, ok := keywordExtra[k]; ok {
			p.WithKeywords = append(p.WithKeywords, x.Also...)
			p.AnyGenres = x.Genres
		}
		for _, kt := range keywordTiles {
			if kt.ID == k {
				title = tr(lang, kt.RU, kt.EN)
			}
		}
	}
	res, err := s.cat.Discover(ctx, p)
	if err != nil {
		return nil, err
	}
	items, err := s.filterForProfile(ctx, profileID, res.Items)
	if err != nil {
		return nil, err
	}
	res.Items = items
	return &BrowsePage{MediaPage: *res, Tile: tile, Title: title}, nil
}

// filterForProfile applies hide_anime/hide_watched/dismissals and adds
// `me` and ratings.
func (s *Service) filterForProfile(ctx context.Context, profileID string, items []catalog.MediaSummary) ([]catalog.MediaSummary, error) {
	ids := make([]string, len(items))
	for i, it := range items {
		ids[i] = it.ID
	}
	st, err := s.profiles.GetSettings(ctx, profileID)
	if err != nil {
		return nil, err
	}
	states, err := s.personal.UserStates(ctx, profileID, ids)
	if err != nil {
		return nil, err
	}
	anime, err := s.animeFilter(ctx, profileID, ids)
	if err != nil {
		return nil, err
	}
	dismissed, err := s.dismissedSet(ctx, profileID, ids)
	if err != nil {
		return nil, err
	}
	hideWatched := st.HideWatched != nil && *st.HideWatched
	sums := map[string]catalog.MediaSummary{}
	for _, it := range items {
		sums[it.ID] = it
	}
	s.annotateRatings(ctx, sums)
	out := make([]catalog.MediaSummary, 0, len(items))
	for _, it := range items {
		st := states[it.ID]
		if anime[it.ID] || dismissed[it.ID] || hideWatched && st.Completed {
			continue
		}
		m := sums[it.ID]
		m.Me = &st
		out = append(out, m)
	}
	return out, nil
}
