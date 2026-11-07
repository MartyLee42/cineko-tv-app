package profiles

import (
	"encoding/json"
	"testing"
)

func TestSettingsFilmTheme(t *testing.T) {
	if d := DefaultSettings(); d.FilmTheme == nil || *d.FilmTheme {
		t.Fatalf("default film_theme = %v, want false", d.FilmTheme)
	}
	if w := (Settings{FilmTheme: ptr(true)}).withDefaults(); !*w.FilmTheme {
		t.Fatal("film_theme on dropped")
	}
	b, _ := json.Marshal(Settings{FilmTheme: ptr(true)})
	if string(b) != `{"film_theme":true}` {
		t.Fatalf("json %s", b)
	}
}
