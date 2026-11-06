package profiles

import (
	"slices"
	"testing"
)

func TestSettingsHiddenTabs(t *testing.T) {
	if got := *DefaultSettings().HiddenTabs; len(got) != 0 {
		t.Fatalf("default hidden_tabs = %v, want none", got)
	}
	ok := Settings{HiddenTabs: &[]string{"ask", "history", "ask"}}
	if f := ok.validate(); len(f) > 0 {
		t.Fatalf("valid tabs rejected: %v", f)
	}
	if got := *ok.withDefaults().HiddenTabs; !slices.Equal(got, []string{"ask", "history"}) {
		t.Fatalf("withDefaults = %v, want deduped [ask history]", got)
	}
	for _, bad := range [][]string{{"home"}, {"settings"}, {"nope"}} {
		if f := (Settings{HiddenTabs: &bad}).validate(); f["hidden_tabs"] == "" {
			t.Fatalf("%v accepted", bad)
		}
	}
	if got := *(Settings{HiddenTabs: &[]string{"zzz", "video"}}).withDefaults().HiddenTabs; !slices.Equal(got, []string{"video"}) {
		t.Fatalf("stored junk not dropped: %v", got)
	}
}
