package foryou

import "testing"

// Kazakh-only letters mean Kazakh; other Cyrillic is Kazakh in a Kazakh app,
// else Russian (і alone, as in Ukrainian, is not Kazakh).
func TestAskLangFollowsTheQuestion(t *testing.T) {
	cases := []struct{ prompt, app, want string }{
		{"что-нибудь доброе на вечер", "en", "ru"},
		{"something cosy for tonight", "ru", "ru"},
		{"something cosy for tonight", "en", "en"},
		{"кешке жеңіл бірдеңе", "en", "kk"},
		{"что-нибудь доброе на вечер", "kk", "kk"},
		{"something cosy for tonight", "kk", "kk"},
		{"Amélie-like films", "en", "en"},
		{"щось добре на вечір", "en", "ru"},
	}
	for _, c := range cases {
		if got := askLang(c.prompt, c.app); got != c.want {
			t.Errorf("askLang(%q, %q) = %q, want %q", c.prompt, c.app, got, c.want)
		}
	}
}
