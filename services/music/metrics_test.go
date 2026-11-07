package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetricsAuth(t *testing.T) {
	e := newAIEnv(t, 1000)
	get := func(auth string) (int, string) {
		req := httptest.NewRequest("GET", "/metrics", nil)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		rec := httptest.NewRecorder()
		e.app.routes().ServeHTTP(rec, req)
		return rec.Code, rec.Body.String()
	}
	if code, _ := get("Bearer x"); code != 404 {
		t.Fatalf("disabled: %d", code)
	}
	e.app.cfg.MetricsToken = "tok"
	for _, h := range []string{"", "Bearer nope", "tok"} {
		if code, _ := get(h); code != 401 {
			t.Fatalf("%q: %d", h, code)
		}
	}
	code, body := get("Bearer tok")
	if code != 200 {
		t.Fatalf("authorized: %d", code)
	}
	for _, want := range []string{"cineko_music_up 1", "cineko_music_ai_enabled 1", "cineko_music_ai_daily_token_budget 1000", "# TYPE cineko_music_go_goroutines gauge"} {
		if !strings.Contains(body, want) {
			t.Errorf("lacks %q in\n%s", want, body)
		}
	}
}
