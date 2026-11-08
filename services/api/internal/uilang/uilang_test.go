package uilang

import (
	"context"
	"io"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v3"
)

func TestCatalogAndName(t *testing.T) {
	for l, want := range map[string][2]string{"ru": {"ru", "Russian"}, "kk": {"ru", "Kazakh (Cyrillic script)"}, "en": {"en", "English"}, "": {"en", "English"}} {
		if Catalog(l) != want[0] || Name(l) != want[1] {
			t.Errorf("%q: Catalog %q Name %q, want %v", l, Catalog(l), Name(l), want)
		}
	}
}

func TestText(t *testing.T) {
	bg := context.Background()
	cases := []struct {
		ui, lang, want string
	}{
		{"", "ru", "ru"},
		{"", "en", "en"},
		{"kk", "ru", "kk"}, // Kazakh app: catalog in Russian, text in Kazakh
		{"kk", "en", "en"}, // asked for English data: English text
		{"ru", "ru", "ru"},
		{"en", "ru", "ru"},
		{"", "kk", "kk"},
		{"xx", "ru", "ru"},
	}
	for _, c := range cases {
		if got := Text(With(bg, c.ui), c.lang); got != c.want {
			t.Errorf("Text(ui=%q, %q) = %q, want %q", c.ui, c.lang, got, c.want)
		}
	}
}

func TestPick(t *testing.T) {
	if Pick("kk", "ру", "en", "қаз") != "қаз" || Pick("kk", "ру", "en", "") != "ру" || Pick("ru", "ру", "en", "қаз") != "ру" || Pick("en", "ру", "en", "қаз") != "en" {
		t.Fatal("Pick")
	}
}

func TestMiddleware(t *testing.T) {
	app := fiber.New()
	app.Use(Middleware())
	app.Get("/", func(c fiber.Ctx) error { return c.SendString(From(c.Context())) })
	for h, want := range map[string]string{"kk": "kk", "en": "en", "de": "", "": ""} {
		req := httptest.NewRequest("GET", "/", nil)
		if h != "" {
			req.Header.Set(Header, h)
		}
		res, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		if string(b) != want {
			t.Errorf("header %q → %q, want %q", h, b, want)
		}
	}
}
