package foryou

import "testing"

func TestAskLangFollowsTheQuestion(t *testing.T) {
	cases := []struct{ prompt, app, want string }{
		{"что-нибудь доброе на вечер", "en", "ru"},
		{"something cosy for tonight", "ru", "ru"},
		{"something cosy for tonight", "en", "en"},
		{"кешке жеңіл бірдеңе", "en", "ru"},
		{"Amélie-like films", "en", "en"},
	}
	for _, c := range cases {
		if got := askLang(c.prompt, c.app); got != c.want {
			t.Errorf("askLang(%q, %q) = %q, want %q", c.prompt, c.app, got, c.want)
		}
	}
}
