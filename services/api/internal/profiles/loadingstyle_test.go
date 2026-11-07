package profiles

import "testing"

func TestSettingsLoadingStyleMarty(t *testing.T) {
	bad := "dancing"
	for _, ok := range []string{"marty", "marty_popcorn", "paws", "aquarium", "speed88", "odyssey", "balloons", "catch"} {
		if f := (Settings{LoadingStyle: &ok}).validate(); len(f) > 0 {
			t.Fatalf("%s rejected: %v", ok, f)
		}
	}
	if f := (Settings{LoadingStyle: &bad}).validate(); f["loading_style"] == "" {
		t.Fatal("unknown loading style accepted")
	}
}
