package profiles

import (
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// design_favorites' item enum lists the same designs as the validator.
func TestSettingsDesignFavoritesMatchContract(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/contracts/openapi.yaml")
	if err != nil {
		t.Skip("contract not mounted:", err)
	}
	m := regexp.MustCompile(`(?s)design_favorites:.*?items: \{ type: string, enum: \[([^\]]+)\]`).FindSubmatch(raw)
	if m == nil {
		t.Fatal("ProfileSettings.design_favorites enum not found")
	}
	var enum []string
	for _, s := range strings.Split(string(m[1]), ",") {
		enum = append(enum, strings.TrimSpace(s))
	}
	if !slices.Equal(enum, designs) {
		t.Fatalf("contract %v, validator %v", enum, designs)
	}
}

func TestSettingsDesignSurprise(t *testing.T) {
	d := DefaultSettings()
	if *d.DesignSurprise != "off" || len(*d.DesignFavorites) != 0 {
		t.Fatalf("defaults: %q %v", *d.DesignSurprise, *d.DesignFavorites)
	}
	for _, m := range SurpriseModes {
		if f := (Settings{DesignSurprise: ptr(m)}).validate(); len(f) > 0 {
			t.Fatalf("%q rejected: %v", m, f)
		}
	}
	if f := (Settings{DesignSurprise: ptr("hour")}).validate(); f["design_surprise"] == "" {
		t.Fatal("hour accepted")
	}
	if got := *(Settings{DesignSurprise: ptr("hour")}).withDefaults().DesignSurprise; got != "off" {
		t.Fatalf("junk mode stored as %q", got)
	}

	ok := Settings{DesignFavorites: &[]string{"matrix", "deco", "matrix"}}
	if f := ok.validate(); len(f) > 0 {
		t.Fatalf("valid favourites rejected: %v", f)
	}
	if got := *ok.withDefaults().DesignFavorites; !slices.Equal(got, []string{"matrix", "deco"}) {
		t.Fatalf("withDefaults = %v, want deduped [matrix deco]", got)
	}
	if f := (Settings{DesignFavorites: &[]string{"deco", "vaporwave"}}).validate(); f["design_favorites"] == "" {
		t.Fatal("unknown design accepted")
	}
	if got := *(Settings{DesignFavorites: &[]string{"zzz", "popart"}}).withDefaults().DesignFavorites; !slices.Equal(got, []string{"popart"}) {
		t.Fatalf("stored junk not dropped: %v", got)
	}
}
