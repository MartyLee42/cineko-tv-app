package releases

import (
	"strings"
	"testing"
)

func vstr(vs []Voiceover) string {
	var parts []string
	for _, v := range vs {
		k, s := "-", "-"
		if v.Kind != nil {
			k = *v.Kind
		}
		if v.Studio != nil {
			s = *v.Studio
		}
		parts = append(parts, k+":"+s+":"+v.Language)
	}
	return strings.Join(parts, ", ")
}

func TestParseVoiceovers(t *testing.T) {
	cases := []struct{ title, want string }{
		{"Игра престолов / Game of Thrones [S01] (2011) WEB-DL 1080p | MVO (LostFilm, NewStudio), AVO (Гаврилов)",
			"mvo:LostFilm:ru, mvo:NewStudio:ru, avo:Гаврилов:ru"},
		{"Тед Лассо (Сезон 1-3) [2020-2023, WEB-DL 2160p] Dub (Red Head Sound) + Original Eng",
			"dub:Red Head Sound:ru, original:-:en"},
		{"Матрица / The Matrix (1999) BDRip 1080p | D, P, A", "dub:-:ru, mvo:-:ru, avo:-:ru"},
		{"Слово пацана. Кровь на асфальте [S01] (2023) WEB-DLRip", ""},
		{"Атака титанов / Shingeki no Kyojin [TV-1] [AniLibria] 1080p", "-:AniLibria:ru"},
		{"Breaking Bad S01 1080p BluRay x264 [LostFilm]", "-:LostFilm:ru"},
		{"Острые козырьки (2013) HDRip | MVO (кубик в кубе)", "mvo:Кубик в Кубе:ru"},
	}
	for _, c := range cases {
		if got := vstr(parseVoiceovers(c.title)); got != c.want {
			t.Errorf("%s\n got  %q\n want %q", c.title, got, c.want)
		}
	}
}

func TestPreferredVoiceoverRanksFirst(t *testing.T) {
	lost, other := "LostFilm", "NewStudio"
	mvo := "mvo"
	mk := func(id, studio string, seeders int) candidate {
		res := "1080p"
		return candidate{Release: Release{ID: id, Seeders: seeders, Resolution: &res, Languages: []string{"ru"},
			Voiceovers: []Voiceover{{Kind: &mvo, Studio: &studio, Language: "ru"}}, Confidence: 1}}
	}
	cands := []candidate{mk("a", other, 200), mk("b", lost, 60)}
	out := Rank(cands, Prefs{Languages: []string{"ru"}, Voiceovers: []string{"lostfilm"}})
	if out[0].ID != "b" {
		t.Fatalf("preferred studio should rank first: %s, %s", out[0].ID, out[1].ID)
	}
	if out2 := Rank(cands, Prefs{Languages: []string{"ru"}}); out2[0].ID != "a" {
		t.Fatal("without preference the better-seeded release wins")
	}
	if len(cands[1].Release.Reasons) != 0 {
		t.Fatal("ranking must not mutate cached candidates")
	}
	_ = lost
}
