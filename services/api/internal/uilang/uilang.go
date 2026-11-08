// Package uilang: the viewer's interface language (ru, en, kk) and the
// language of text the server writes for them.
//
// Catalog data (TMDB titles, plots, names) exists only in ru and en, so the
// apps ask for catalog data in Catalog(locale): Kazakh reads the Russian
// catalog. Text the server generates — AI answers, «Ранее в сериале»,
// personal reasons, rubric titles — follows the interface language instead:
// the apps send it in the X-Cineko-Language header (Middleware puts it in
// the request context) and background jobs use the profile's ui_language.
package uilang

import (
	"context"

	"github.com/gofiber/fiber/v3"
)

// Header carries the language the app is showing (en | ru | kk).
const Header = "X-Cineko-Language"

// All: the interface languages.
var All = []string{"en", "ru", "kk"}

// Valid: one of All.
func Valid(l string) bool { return l == "en" || l == "ru" || l == "kk" }

// Catalog is the catalog-data language for an interface language: Kazakh
// reads Russian titles and plots (TMDB has little Kazakh).
func Catalog(l string) string {
	if l == "ru" || l == "kk" {
		return "ru"
	}
	return "en"
}

// Name is the language's English name, for AI prompts ("Write in …").
func Name(l string) string {
	switch l {
	case "ru":
		return "Russian"
	case "kk":
		return "Kazakh (Cyrillic script)"
	}
	return "English"
}

// Pick returns the text for l: Kazakh falls back to Russian when kk is empty.
func Pick(l, ru, en, kk string) string {
	switch {
	case l == "kk" && kk != "":
		return kk
	case l == "ru" || l == "kk":
		return ru
	}
	return en
}

type ctxKey struct{}

// With returns ctx carrying the interface language l (ignored when invalid).
func With(ctx context.Context, l string) context.Context {
	if !Valid(l) {
		return ctx
	}
	return context.WithValue(ctx, ctxKey{}, l)
}

// From is the interface language in ctx ("" when the request didn't say).
func From(ctx context.Context) string {
	l, _ := ctx.Value(ctxKey{}).(string)
	return l
}

// Text is the language of generated text for a request whose catalog
// language is lang: the interface language when it reads that catalog
// (kk for a Kazakh app asking with lang=ru), else lang itself.
func Text(ctx context.Context, lang string) string {
	if u := From(ctx); u != "" && Catalog(u) == Catalog(lang) {
		return u
	}
	return lang
}

// Middleware stores the X-Cineko-Language header in the request context.
func Middleware() fiber.Handler {
	return func(c fiber.Ctx) error {
		if l := c.Get(Header); Valid(l) {
			c.SetContext(With(c.Context(), l))
		}
		return c.Next()
	}
}
