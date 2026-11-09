package releases

import (
	"slices"
	"testing"

	"martytv/api/internal/integrations/tmdb"
)

func TestBuildQueries(t *testing.T) {
	one := 1
	cases := []struct {
		name         string
		t            Target
		ru, en, orig string
		want         []string
	}{
		{"latin movie unchanged", Target{Kind: "movie", Year: 1999, OriginalLanguage: "en", SearchNames: []string{"Ignored"}},
			"Матрица", "The Matrix", "The Matrix",
			[]string{"The Matrix 1999", "Матрица 1999", "Матрица"}},
		{"latin series unchanged", Target{Kind: "series", Season: &one, OriginalLanguage: "en"},
			"Игра престолов", "Game of Thrones", "Game of Thrones",
			[]string{"Игра престолов", "Game of Thrones", "Игра престолов 1 сезон", "Game of Thrones S01"}},
		{"japanese movie without romanization", Target{Kind: "movie", Year: 2001, OriginalLanguage: "ja"},
			"Унесённые призраками", "Spirited Away", "千と千尋の神隠し",
			[]string{"Унесённые призраками 2001", "Унесённые призраками", "Spirited Away 2001", "千と千尋の神隠し"}},
		{"japanese movie", Target{Kind: "movie", Year: 2001, OriginalLanguage: "ja", SearchNames: []string{"Sen to Chihiro no Kamikakushi"}},
			"Унесённые призраками", "Spirited Away", "千と千尋の神隠し",
			[]string{"Унесённые призраками 2001", "Унесённые призраками", "Spirited Away 2001",
				"Sen to Chihiro no Kamikakushi 2001", "千と千尋の神隠し"}},
		{"korean series season", Target{Kind: "series", Season: &one, OriginalLanguage: "ko",
			SearchNames: []string{"Sseulsseulhago Chanlanhasin: Dokkaebi", "Dokkaebi"}},
			"Гоблин", "Guardian: The Lonely and Great God", "쓸쓸하고 찬란하神-도깨비",
			[]string{"Гоблин", "Guardian The Lonely and Great God", "Гоблин 1 сезон", "Guardian The Lonely and Great God S01",
				"Sseulsseulhago Chanlanhasin Dokkaebi", "Dokkaebi"}},
		{"korean series season, one name", Target{Kind: "series", Season: &one, OriginalLanguage: "ko",
			SearchNames: []string{"Sseulsseulhago Chanlanhasin: Dokkaebi"}},
			"Гоблин", "Guardian: The Lonely and Great God", "쓸쓸하고 찬란하神-도깨비",
			[]string{"Гоблин", "Guardian The Lonely and Great God", "Гоблин 1 сезон", "Guardian The Lonely and Great God S01",
				"Sseulsseulhago Chanlanhasin Dokkaebi", "Sseulsseulhago Chanlanhasin Dokkaebi S01"}},
		{"korean series", Target{Kind: "series", OriginalLanguage: "ko", SearchNames: []string{"Dokkaebi"}},
			"Гоблин", "Guardian: The Lonely and Great God", "쓸쓸하고 찬란하神-도깨비",
			[]string{"Гоблин", "Guardian The Lonely and Great God", "Dokkaebi", "쓸쓸하고 찬란하神-도깨비"}},
		{"greek original: names, no native", Target{Kind: "series", OriginalLanguage: "el", SearchNames: []string{"Kokkino Potami"}},
			"Красная река", "Red River", "Κόκκινο Ποτάμι",
			[]string{"Красная река", "Red River", "Kokkino Potami"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := buildQueries(&c.t, c.ru, c.en, c.orig)
			if !slices.Equal(got, c.want) {
				t.Fatalf("got  %q\nwant %q", got, c.want)
			}
		})
	}
}

func TestSearchNames(t *testing.T) {
	alts := []tmdb.AlternativeTitle{
		{Country: "US", Title: "Goblin", Type: ""},
		{Country: "KR", Title: "Dokkaebi", Type: ""},
		{Country: "KR", Title: "도깨비", Type: ""},
		{Country: "KR", Title: "Sseulsseulhago Chanlanhasin: Dokkaebi", Type: "Romanization"},
		{Country: "RU", Title: "Гоблин", Type: ""},
		{Country: "KR", Title: "GUARDIAN – The Lonely and Great God", Type: ""},
	}
	c := searchCandidates(alts)
	want := []string{"Sseulsseulhago Chanlanhasin: Dokkaebi", "Dokkaebi", "GUARDIAN – The Lonely and Great God"}
	if !slices.Equal(c, want) {
		t.Fatalf("candidates %q", c)
	}
	got := pickSearchNames([]string{"Guardian: the lonely & great god", "Dokkaebi", "Dokkaebi!", "Goblin", "Extra"},
		"쓸쓸하고 찬란하神-도깨비", "Гоблин", "Guardian: The Lonely and Great God")
	if !slices.Equal(got, []string{"Dokkaebi", "Goblin"}) {
		t.Fatalf("picked %q", got)
	}
}
