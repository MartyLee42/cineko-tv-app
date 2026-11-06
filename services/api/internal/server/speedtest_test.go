package server_test

import (
	"bytes"
	"compress/gzip"
	"strconv"
	"testing"

	"martytv/api/internal/server"
	"martytv/api/internal/testutil"
)

// GET /speedtest: N incompressible bytes for signed-in users and TVs,
// never cached; the size is capped and requests are rate-limited.
func TestSpeedtest(t *testing.T) {
	env := testutil.New(t)
	env.Client().Do("GET", "/api/v1/speedtest?bytes=1000", nil).Expect(401)

	alice, _ := env.NewUserClient("alice", "user")
	r := alice.Do("GET", "/api/v1/speedtest?bytes=300000", nil).Expect(200)
	if len(r.Body) != 300000 {
		t.Fatalf("body %d bytes, want 300000", len(r.Body))
	}
	if ct := r.Header.Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("content-type %q", ct)
	}
	if cc := r.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("cache-control %q", cc)
	}
	if cl := r.Header.Get("Content-Length"); cl != "300000" {
		t.Fatalf("content-length %q", cl)
	}
	// Incompressible: gzip can't shrink it.
	var z bytes.Buffer
	w := gzip.NewWriter(&z)
	_, _ = w.Write(r.Body)
	_ = w.Close()
	if z.Len() < len(r.Body)*99/100 {
		t.Fatalf("gzip shrank the payload to %d of %d bytes", z.Len(), len(r.Body))
	}
	// Default size: 1 MiB.
	if n := len(alice.Do("GET", "/api/v1/speedtest", nil).Expect(200).Body); n != 1<<20 {
		t.Fatalf("default size %d", n)
	}

	// Validation: 0, junk and over the cap.
	for _, q := range []string{"0", "-5", "abc", strconv.Itoa(server.SpeedtestMaxBytes + 1)} {
		if code := alice.Do("GET", "/api/v1/speedtest?bytes="+q, nil).Expect(422).ErrorCode(); code != "validation_failed" {
			t.Fatalf("bytes=%s: %s", q, code)
		}
	}

	// A paired TV may use it (its own rate-limit bucket).
	_, cred := env.Pair(alice, "TV")
	tv := env.Client()
	tv.Bearer = cred
	if n := len(tv.Do("GET", "/api/v1/speedtest?bytes=1234", nil).Expect(200).Body); n != 1234 {
		t.Fatalf("tv body %d", n)
	}

	// Rate limit per principal: alice used 2 (+4 rejected validations don't count).
	for i := 0; i < 28; i++ {
		alice.Do("GET", "/api/v1/speedtest?bytes=10", nil).Expect(200)
	}
	r = alice.Do("GET", "/api/v1/speedtest?bytes=10", nil).Expect(429)
	if r.ErrorCode() != "rate_limited" {
		t.Fatalf("code %s", r.ErrorCode())
	}
	// …the TV's bucket is separate.
	tv.Do("GET", "/api/v1/speedtest?bytes=10", nil).Expect(200)
}
