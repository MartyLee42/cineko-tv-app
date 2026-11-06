package profiles

import (
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func TestSettingsDesigns(t *testing.T) {
	for _, d := range []string{"kinozal", "terminal", "projector", "wireframe", "cyberpunk", "deco", "retro80", "retro90", "popart", "constructivism"} {
		if f := (Settings{Design: ptr(d)}).validate(); len(f) > 0 {
			t.Fatalf("design %q rejected: %v", d, f)
		}
		if st := (Settings{Design: ptr(d)}).withDefaults(); *st.Design != d {
			t.Fatalf("design %q stored as %q", d, *st.Design)
		}
	}
	f := (Settings{Design: ptr("vaporwave")}).validate()
	if !strings.Contains(f["design"], "deco") {
		t.Fatalf("unknown design: %v", f)
	}
	if st := (Settings{Design: ptr("vaporwave")}).withDefaults(); *st.Design != "kinozal" {
		t.Fatalf("fallback %q", *st.Design)
	}
}

// The validator's list matches the OpenAPI enum (the contract is the source of truth).
func TestSettingsDesignsMatchContract(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/contracts/openapi.yaml")
	if err != nil {
		t.Skip("contract not mounted:", err)
	}
	m := regexp.MustCompile(`(?m)^\s+design: \{ type: string, enum: \[([^\]]+)\]`).FindSubmatch(raw)
	if m == nil {
		t.Fatal("ProfileSettings.design enum not found")
	}
	var enum []string
	for _, s := range strings.Split(string(m[1]), ",") {
		enum = append(enum, strings.TrimSpace(s))
	}
	if !slices.Equal(enum, designs) {
		t.Fatalf("contract %v, validator %v", enum, designs)
	}
}
