package ratings

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testKey = "secret-key-123"

func TestUnofficialProvider(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-KEY") != testKey {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		q := r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v2.2/films" && q.Get("imdbId") == "tt0133093":
			_, _ = w.Write([]byte(`{"total":1,"totalPages":1,"items":[{"kinopoiskId":301,"imdbId":"tt0133093","nameRu":"Матрица","nameEn":null,"nameOriginal":"The Matrix","year":1999,"type":"FILM","ratingKinopoisk":8.5}]}`))
		case r.URL.Path == "/api/v2.2/films" && q.Get("keyword") == "Во все тяжкие":
			if q.Get("yearFrom") != "2007" || q.Get("yearTo") != "2009" || q.Get("order") != "NUM_VOTE" {
				t.Errorf("query %v", q)
			}
			_, _ = w.Write([]byte(`{"total":1,"totalPages":1,"items":[{"kinopoiskId":404900,"imdbId":"tt0903747","nameRu":"Во все тяжкие","nameOriginal":"Breaking Bad","year":2008,"type":"TV_SERIES"}]}`))
		case r.URL.Path == "/api/v2.2/films" && q.Get("keyword") == "quota":
			w.WriteHeader(http.StatusPaymentRequired)
		case r.URL.Path == "/api/v1/api_keys/"+testKey:
			_, _ = w.Write([]byte(`{"totalQuota":{"value":1000,"used":5},"dailyQuota":{"value":500,"used":20},"accountType":"FREE"}`))
		default:
			_, _ = w.Write([]byte(`{"total":0,"totalPages":0,"items":[]}`))
		}
	}))
	defer srv.Close()
	ctx := context.Background()
	p := NewUnofficial(srv.URL, testKey, HTTPClient(nil, 2*time.Second))

	c, err := p.ByIMDb(ctx, "tt0133093")
	if err != nil || len(c) != 1 || c[0].KPID != 301 || c[0].IMDbID != "tt0133093" || *c[0].Series || c[0].Year != 1999 ||
		strings.Join(c[0].Names, "|") != "Матрица|The Matrix" {
		t.Fatalf("%+v %v", c, err)
	}
	c, err = p.ByTitle(ctx, "Во все тяжкие", 2008)
	if err != nil || len(c) != 1 || !*c[0].Series {
		t.Fatalf("%+v %v", c, err)
	}
	if _, err := p.ByTitle(ctx, "quota", 0); !errors.Is(err, ErrQuota) {
		t.Fatal(err)
	}
	rem, plan, ok, err := p.Quota(ctx)
	if err != nil || !ok || rem != 480 || plan != "FREE" {
		t.Fatalf("quota %d %q %v %v", rem, plan, ok, err)
	}

	bad := NewUnofficial(srv.URL, "wrong", HTTPClient(nil, 2*time.Second))
	if _, err := bad.ByIMDb(ctx, "tt1"); !errors.Is(err, ErrUnauthorized) {
		t.Fatal(err)
	}
	// Transport errors never echo the URL (the key sits in a path).
	down := NewUnofficial("http://127.0.0.1:1", testKey, HTTPClient(nil, time.Second))
	if _, _, _, err := down.Quota(ctx); err == nil || strings.Contains(err.Error(), testKey) {
		t.Fatalf("leak: %v", err)
	}
}

func TestDevProvider(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.Header.Get("X-API-KEY") != testKey || r.URL.Path != "/v1.5/movie" || len(q["selectFields"]) == 0 {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch {
		case q.Get("externalId.tmdb") == "1396":
			_, _ = w.Write([]byte(`{"docs":[{"id":404900,"name":"Во все тяжкие","alternativeName":"Breaking Bad","year":2008,"isSeries":true,"externalId":{"imdb":"tt0903747","tmdb":1396}}],"limit":10}`))
		case q.Get("externalId.imdb") == "limit":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"Вы израсходовали ваш суточный лимит"}`))
		default:
			_, _ = w.Write([]byte(`{"docs":[],"limit":10}`))
		}
	}))
	defer srv.Close()
	ctx := context.Background()
	p := NewDev(srv.URL, testKey, HTTPClient(nil, 2*time.Second))
	c, err := p.ByTMDB(ctx, 1396)
	if err != nil || len(c) != 1 || c[0].KPID != 404900 || c[0].TMDBID != 1396 || c[0].IMDbID != "tt0903747" || !*c[0].Series {
		t.Fatalf("%+v %v", c, err)
	}
	if id, ok := Pick(Target{Kind: "series", TMDBID: 1396}, c); !ok || id != 404900 {
		t.Fatal("pick")
	}
	if _, err := p.ByIMDb(ctx, "limit"); !errors.Is(err, ErrQuota) {
		t.Fatal(err)
	}
}
