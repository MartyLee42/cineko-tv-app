// Package metrics serves GET /metrics in the Prometheus text format for
// Prometheus / Grafana / VictoriaMetrics (docs/deployment.md «Метрики»).
//
// Off unless METRICS_TOKEN is set (then 404), and every scrape needs
// "Authorization: Bearer $METRICS_TOKEN". Caddy never proxies /metrics, so
// it is reachable only inside the compose network (api:8080/metrics).
//
// Three kinds of series:
//   - live, read at scrape time (Go runtime, process, HTTP requests, DB
//     pool, active streams, WebSockets): all in-memory;
//   - a snapshot refreshed every RefreshInterval by Refresher from Sources
//     (host load, integrations, DB counts, device health, AI usage), so a
//     scrape normally never queries the database or probes an integration
//     (the refresh pauses when nobody scrapes; the first scrape after a
//     pause refreshes inline);
//   - cineko_build_info.
//
// Labels stay bounded: HTTP routes are route templates (never raw paths),
// devices are ids + model, never names.
package metrics

import (
	"crypto/subtle"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/adaptor"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"martytv/api/internal/httpx"
)

// Namespace prefixes every Cineko series.
const Namespace = "cineko"

// Metrics owns the registry, the HTTP instrumentation and the handler.
type Metrics struct {
	reg      *prometheus.Registry
	token    string
	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
	handler  fiber.Handler
}

// New builds the registry with the Go runtime and process collectors and
// cineko_build_info{version}. token "" = the endpoint answers 404.
func New(token, version string) *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		reg:   reg,
		token: token,
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: Namespace, Name: "http_requests_total",
			Help: "API requests by method, route template and status class.",
		}, []string{"method", "route", "status"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: Namespace, Name: "http_request_duration_seconds",
			Help:    "API request latency by method and route template (streams count until they end).",
			Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 120},
		}, []string{"method", "route"}),
	}
	build := prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: Namespace, Name: "build_info", Help: "Cineko API version (always 1).",
		ConstLabels: prometheus.Labels{"version": version},
	})
	build.Set(1)
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.requests, m.duration, build,
	)
	m.handler = adaptor.HTTPHandler(promhttp.HandlerFor(reg, promhttp.HandlerOpts{ErrorHandling: promhttp.ContinueOnError}))
	return m
}

// Registry is where the server registers its own collectors.
func (m *Metrics) Registry() *prometheus.Registry { return m.reg }

// Enabled reports whether METRICS_TOKEN is set.
func (m *Metrics) Enabled() bool { return m.token != "" }

// Routes mounts GET /metrics on the root app (outside /api, so the reverse
// proxy doesn't publish it).
func (m *Metrics) Routes(app fiber.Router) {
	app.Get("/metrics", m.Handler())
}

// Handler is GET /metrics: 404 when disabled, 401 without the right bearer
// token, else the text exposition.
func (m *Metrics) Handler() fiber.Handler {
	return func(c fiber.Ctx) error {
		if m.token == "" {
			return c.SendStatus(fiber.StatusNotFound)
		}
		if !m.authorized(c.Get(fiber.HeaderAuthorization)) {
			c.Set(fiber.HeaderWWWAuthenticate, `Bearer realm="metrics"`)
			return c.SendStatus(fiber.StatusUnauthorized)
		}
		c.Set(fiber.HeaderCacheControl, "no-store")
		return m.handler(c)
	}
}

func (m *Metrics) authorized(header string) bool {
	scheme, tok, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(strings.TrimSpace(tok)), []byte(m.token)) == 1
}

// Middleware counts every request by method, route template and status
// class. Register it right after recover so it sees the final status.
func (m *Metrics) Middleware() fiber.Handler {
	return func(c fiber.Ctx) error {
		start := time.Now()
		err := c.Next()
		method := methodLabel(c.Method())
		route := RouteLabel(c)
		m.requests.WithLabelValues(method, route, StatusClass(finalStatus(c, err))).Inc()
		m.duration.WithLabelValues(method, route).Observe(time.Since(start).Seconds())
		return err
	}
}

// RouteLabel is the registered route template ("/api/v1/media/:id") of the
// endpoint that handled — or would have handled — the request, or
// "unmatched" (404s, scanners), so raw paths never become labels.
func RouteLabel(c fiber.Ctx) string {
	if r := c.Endpoint(); r != nil && r.Path != "" {
		return r.Path
	}
	return "unmatched"
}

// finalStatus estimates the status the error handler will send for err
// (it has not run yet), like httpx.LoggerMiddleware.
func finalStatus(c fiber.Ctx, err error) int {
	if err == nil {
		return c.Response().StatusCode()
	}
	var he *httpx.Error
	var fe *fiber.Error
	switch {
	case errors.As(err, &he):
		return he.Status
	case errors.As(err, &fe):
		return fe.Code
	}
	return fiber.StatusInternalServerError
}

// StatusClass maps 204 → "2xx"; anything odd → "other".
func StatusClass(code int) string {
	if code < 100 || code > 599 {
		return "other"
	}
	return strconv.Itoa(code/100) + "xx"
}

func methodLabel(m string) string {
	switch m {
	case fiber.MethodGet, fiber.MethodHead, fiber.MethodPost, fiber.MethodPut, fiber.MethodPatch,
		fiber.MethodDelete, fiber.MethodOptions:
		return m
	}
	return "OTHER"
}
