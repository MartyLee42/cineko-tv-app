package main

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// GET /metrics (Prometheus text format), the same rule as the API: 404
// without METRICS_TOKEN, else "Authorization: Bearer $METRICS_TOKEN".
// Outside /music, so Caddy never proxies it (scrape music:8080/metrics).
// A few cheap numbers only: Go runtime, transcodes, AI usage today.
func (a *App) hMetrics(w http.ResponseWriter, r *http.Request) {
	tok := a.cfg.MetricsToken
	if tok == "" {
		http.NotFound(w, r)
		return
	}
	scheme, got, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	if !strings.EqualFold(scheme, "Bearer") || subtle.ConstantTimeCompare([]byte(strings.TrimSpace(got)), []byte(tok)) != 1 {
		w.Header().Set("WWW-Authenticate", `Bearer realm="metrics"`)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	_, tokens := a.st.AIUsage(r.Context(), "", aiDay(time.Now()))
	var b strings.Builder
	g := func(name, help string, v float64) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s gauge\n%s %g\n", name, help, name, name, v)
	}
	g("cineko_music_up", "1 while Cineko Music answers.", 1)
	g("cineko_music_go_goroutines", "Goroutines.", float64(runtime.NumGoroutine()))
	g("cineko_music_go_heap_alloc_bytes", "Go heap in use.", float64(ms.HeapAlloc))
	g("cineko_music_go_sys_bytes", "Memory obtained from the OS.", float64(ms.Sys))
	g("cineko_music_active_transcodes", "Audio transcodes running.", float64(len(a.tcSem)))
	g("cineko_music_max_transcodes", "Transcode limit (MUSIC_MAX_TRANSCODES).", float64(cap(a.tcSem)))
	g("cineko_music_ai_enabled", "1 when a DeepSeek key is configured.", boolFloat(a.ai.Configured()))
	g("cineko_music_ai_tokens_today", "DeepSeek tokens used today (Moscow day), all accounts.", float64(tokens))
	g("cineko_music_ai_daily_token_budget", "MUSIC_AI_DAILY_TOKENS (0 = unlimited).", float64(a.cfg.AIDayTokens))
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(b.String()))
}

func boolFloat(v bool) float64 {
	if v {
		return 1
	}
	return 0
}
