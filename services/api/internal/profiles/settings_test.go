package profiles

import (
	"strings"
	"testing"
)

func TestSettingsTasteNoteAndMinVotes(t *testing.T) {
	d := DefaultSettings()
	if *d.TasteNote != "" || *d.MinVotes != DefaultMinVotes {
		t.Fatalf("defaults %q %d", *d.TasteNote, *d.MinVotes)
	}
	ok := Settings{TasteNote: ptr("  " + strings.Repeat("я", TasteNoteMax) + "\n "), MinVotes: ptr(5000)}
	if f := ok.validate(); len(f) > 0 {
		t.Fatalf("valid settings rejected: %v", f)
	}
	for _, mv := range MinVotesChoices {
		if f := (Settings{MinVotes: ptr(mv)}).validate(); len(f) > 0 {
			t.Fatalf("min_votes %d rejected", mv)
		}
	}
	bad := Settings{TasteNote: ptr(strings.Repeat("a", TasteNoteMax+1)), MinVotes: ptr(200)}
	f := bad.validate()
	if f["taste_note"] == "" || f["min_votes"] == "" {
		t.Fatalf("fields %v", f)
	}
	if f := (Settings{MinVotes: ptr(-1)}).validate(); f["min_votes"] == "" {
		t.Fatal("negative min_votes accepted")
	}
	if got := NormalizeTasteNote("  люблю\tтриллеры\x00\nи фантастику  "); got != "люблю триллеры \nи фантастику" {
		t.Fatalf("normalized %q", got)
	}
	// Stored garbage falls back to the default.
	if st := (Settings{MinVotes: ptr(7)}).withDefaults(); *st.MinVotes != DefaultMinVotes {
		t.Fatalf("min_votes fallback %d", *st.MinVotes)
	}
}
