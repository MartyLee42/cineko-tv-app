package profiles

import (
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// seasonal_effects: "off" by default (users turn it on in Settings); on/calm/off
// accepted, anything else 422; a stored unknown value falls back to "off".
func TestSettingsSeasonalEffects(t *testing.T) {
	if got := *DefaultSettings().SeasonalEffects; got != "off" {
		t.Fatalf("default %q", got)
	}
	for _, m := range SeasonalModes {
		if f := (Settings{SeasonalEffects: ptr(m)}).validate(); len(f) > 0 {
			t.Fatalf("%q rejected: %v", m, f)
		}
		if got := *(Settings{SeasonalEffects: ptr(m)}).withDefaults().SeasonalEffects; got != m {
			t.Fatalf("%q kept as %q", m, got)
		}
	}
	for _, bad := range []string{"", "ON", "static", "true"} {
		if f := (Settings{SeasonalEffects: ptr(bad)}).validate(); f["seasonal_effects"] == "" {
			t.Fatalf("%q accepted", bad)
		}
	}
	if got := *(Settings{SeasonalEffects: ptr("loud")}).withDefaults().SeasonalEffects; got != "off" {
		t.Fatalf("fallback %q", got)
	}
	if got := *(Settings{}).withDefaults().SeasonalEffects; got != "off" {
		t.Fatalf("unset %q", got)
	}
}

// The validator's modes match the OpenAPI enum.
func TestSeasonalModesMatchContract(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/contracts/openapi.yaml")
	if err != nil {
		t.Skip("contract not mounted:", err)
	}
	m := regexp.MustCompile(`(?m)^\s+seasonal_effects: \{ type: string, enum: \[([^\]]+)\]`).FindSubmatch(raw)
	if m == nil {
		t.Fatal("ProfileSettings.seasonal_effects enum not found")
	}
	var enum []string
	for _, s := range strings.Split(string(m[1]), ",") {
		enum = append(enum, strings.Trim(strings.TrimSpace(s), `"`))
	}
	if !slices.Equal(enum, SeasonalModes) {
		t.Fatalf("contract %v, validator %v", enum, SeasonalModes)
	}
}
