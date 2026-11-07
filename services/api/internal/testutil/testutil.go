// Package testutil starts a real Cineko server against PostgreSQL for
// integration tests. Each Env gets its own schema, so tests can run in
// parallel and leave nothing behind.
//
// Set TEST_DATABASE_URL (see `make test-go`); tests are skipped without it.
package testutil

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/auth"
	"martytv/api/internal/config"
	"martytv/api/internal/db"
	"martytv/api/internal/server"
	"martytv/api/internal/users"
)

type Env struct {
	T       *testing.T
	Pool    *pgxpool.Pool
	Server  *server.Server
	BaseURL string
	Origin  string
	Config  *config.Config
}

// Options tweak the server config for a test.
type Options func(*config.Config)

func New(t *testing.T, opts ...Options) *Env {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()

	schema := "t_" + randHex(6)
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})

	cfgPool, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfgPool.ConnConfig.RuntimeParams["search_path"] = schema
	cfgPool.ConnConfig.RuntimeParams["timezone"] = "UTC"
	pool, err := pgxpool.NewWithConfig(ctx, cfgPool)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	base := "http://" + ln.Addr().String()
	cfg, err := config.LoadFrom(func(k string) string {
		switch k {
		case "DATABASE_URL":
			return dsn
		case "APP_SESSION_SECRET":
			return "test-secret-test-secret-test-secret-0000"
		case "PUBLIC_BASE_URL":
			return base
		case "JACRED_URL":
			return "off" // never reach the public instance from tests
		case "KINOPOISK_WIKIDATA_URL":
			return "off" // ratings tests point it at a fake
		case "THEINTRODB_URL", "INTRODB_URL":
			return "off" // intro/credits databases: segments tests use fakes
		case "NEW_TV_DESIGN":
			return "off" // paired TVs follow their profiles (tests opt in)
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range opts {
		o(cfg)
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if os.Getenv("TEST_LOG") != "" {
		log = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	srv := server.New(cfg, pool, log)
	// Online balancers scrape public sites: never reach the internet from
	// tests (provider tests use httptest fakes).
	for _, id := range []string{"cdnvideohub", "collaps"} {
		srv.Sources.Unregister(id)
	}
	go func() { _ = srv.App.Listener(ln, fiber.ListenConfig{DisableStartupMessage: true}) }()
	t.Cleanup(func() { _ = srv.App.ShutdownWithTimeout(2 * time.Second) })

	return &Env{T: t, Pool: pool, Server: srv, BaseURL: base, Origin: base, Config: cfg}
}

// CreateUser inserts a user directly.
func (e *Env) CreateUser(username, password, role string) *users.User {
	e.T.Helper()
	hash, err := auth.HashPassword(context.Background(), password)
	if err != nil {
		e.T.Fatal(err)
	}
	u, err := users.NewStore(e.Pool).Create(context.Background(), username, "", role, hash)
	if err != nil {
		e.T.Fatal(err)
	}
	return u
}

// Client is an HTTP client with a cookie jar, acting like one browser.
type Client struct {
	env    *Env
	http   *http.Client
	CSRF   string
	Bearer string
	Origin string
}

func (e *Env) Client() *Client {
	jar, _ := cookiejar.New(nil)
	return &Client{env: e, http: &http.Client{Jar: jar, Timeout: 10 * time.Second}, Origin: e.Origin}
}

// Login signs in and stores the CSRF token.
func (c *Client) Login(username, password string) *Client {
	c.env.T.Helper()
	res := c.Do("POST", "/api/v1/auth/login", map[string]string{"username": username, "password": password})
	res.Expect(200)
	c.CSRF = res.JSON()["csrf_token"].(string)
	return c
}

// NewUserClient creates a user and returns a signed-in client.
func (e *Env) NewUserClient(username, role string) (*Client, *users.User) {
	pw := "password-" + username
	u := e.CreateUser(username, pw, role)
	return e.Client().Login(username, pw), u
}

type Response struct {
	T      *testing.T
	Status int
	Body   []byte
	Header http.Header
}

func (r *Response) Expect(status int) *Response {
	r.T.Helper()
	if r.Status != status {
		r.T.Fatalf("expected HTTP %d, got %d: %s", status, r.Status, r.Body)
	}
	return r
}

func (r *Response) JSON() map[string]any {
	r.T.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.Body, &m); err != nil {
		r.T.Fatalf("invalid JSON %q: %v", r.Body, err)
	}
	return m
}

func (r *Response) Items() []map[string]any {
	r.T.Helper()
	raw, _ := r.JSON()["items"].([]any)
	out := make([]map[string]any, len(raw))
	for i, v := range raw {
		out[i] = v.(map[string]any)
	}
	return out
}

func (r *Response) ErrorCode() string {
	r.T.Helper()
	e, _ := r.JSON()["error"].(map[string]any)
	code, _ := e["code"].(string)
	return code
}

// Do sends a request. Unsafe methods carry the CSRF token and Origin.
func (c *Client) Do(method, path string, body any, headers ...string) *Response {
	c.env.T.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.env.BaseURL+path, rd)
	if err != nil {
		c.env.T.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if method != "GET" {
		if c.Origin != "" {
			req.Header.Set("Origin", c.Origin)
		}
		if c.CSRF != "" {
			req.Header.Set("X-CSRF-Token", c.CSRF)
		}
	}
	if c.Bearer != "" {
		req.Header.Set("Authorization", "Bearer "+c.Bearer)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := c.http.Do(req)
	if err != nil {
		c.env.T.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return &Response{T: c.env.T, Status: resp.StatusCode, Body: b, Header: resp.Header}
}

// SessionCookie returns the client's raw session cookie value.
func (c *Client) SessionCookie() string {
	u, _ := url.Parse(c.env.BaseURL)
	for _, ck := range c.http.Jar.Cookies(u) {
		if ck.Name == auth.SessionCookie {
			return ck.Value
		}
	}
	return ""
}

// WSURL is the realtime endpoint.
func (e *Env) WSURL() string { return "ws" + strings.TrimPrefix(e.BaseURL, "http") + "/api/v1/ws" }

// Pair runs the whole TV pairing flow for an approving client and returns the
// device ID and credential.
func (e *Env) Pair(approver *Client, name string) (string, string) {
	e.T.Helper()
	tv := e.Client()
	start := tv.Do("POST", "/api/v1/pairing", map[string]string{"device_name": name}).Expect(201).JSON()
	id := start["pairing_id"].(string)
	approver.Do("POST", "/api/v1/pairing/"+id+"/approve", map[string]any{}).Expect(204)
	res := tv.Do("POST", "/api/v1/pairing/"+id+"/exchange", nil, "Authorization", "Pairing "+start["poll_secret"].(string)).Expect(200).JSON()
	dev := res["device"].(map[string]any)
	return dev["id"].(string), res["credential"].(string)
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
