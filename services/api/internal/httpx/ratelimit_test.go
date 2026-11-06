package httpx

import (
	"testing"
	"time"
)

func TestRateLimiter(t *testing.T) {
	now := time.Unix(0, 0)
	r := NewRateLimiter(2, time.Minute)
	r.now = func() time.Time { return now }
	if ok, _ := r.Allow("a"); !ok {
		t.Fatal()
	}
	if ok, _ := r.Allow("a"); !ok {
		t.Fatal()
	}
	if ok, wait := r.Allow("a"); ok || wait != time.Minute {
		t.Fatalf("third hit allowed=%v wait=%v", ok, wait)
	}
	if ok, _ := r.Allow("b"); !ok {
		t.Fatal("keys must be independent")
	}
	now = now.Add(time.Minute)
	if ok, _ := r.Allow("a"); !ok {
		t.Fatal("window should reset")
	}
}

func TestLockoutBacksOffExponentially(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewLockout(3, 10*time.Second, time.Minute)
	l.now = func() time.Time { return now }
	for i := 0; i < 2; i++ {
		l.Fail("u")
	}
	if l.Check("u") != 0 {
		t.Fatal("locked too early")
	}
	l.Fail("u")
	if d := l.Check("u"); d != 10*time.Second {
		t.Fatalf("first lock %v", d)
	}
	l.Fail("u")
	if d := l.Check("u"); d != 20*time.Second {
		t.Fatalf("second lock %v", d)
	}
	for i := 0; i < 10; i++ {
		l.Fail("u")
	}
	if d := l.Check("u"); d != time.Minute {
		t.Fatalf("lock should cap at max, got %v", d)
	}
	l.Succeed("u")
	if l.Check("u") != 0 {
		t.Fatal("success should clear")
	}
}

func TestMatchOrigin(t *testing.T) {
	allowed := []string{"https://tv.example.com"}
	if !MatchOrigin("https://TV.example.com/", allowed) {
		t.Fatal("case/trailing slash should match")
	}
	if MatchOrigin("https://tv.example.com.evil.io", allowed) || MatchOrigin("http://tv.example.com", allowed) {
		t.Fatal("lookalike origin matched")
	}
	if originOf("https://a.b/c?d") != "https://a.b" {
		t.Fatal("originOf")
	}
}
