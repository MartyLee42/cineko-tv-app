package playback

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestStreamToken(t *testing.T) {
	s := newSigner([]byte("secret-one-secret-one-secret-one-00"))
	id := "3f1c2a7e-8a5b-4c1d-9e2f-0123456789ab"
	now := time.Now()
	tok, err := s.Sign(id, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(tok, "+/=") || strings.Contains(tok, strings.ReplaceAll(id, "-", "")) {
		t.Fatalf("token not opaque base64url: %s", tok)
	}
	got, err := s.Verify(tok, now)
	if err != nil || got != id {
		t.Fatalf("verify: %v %q", err, got)
	}

	// Expired.
	if _, err := s.Verify(tok, now.Add(2*time.Hour)); !errors.Is(err, errExpiredToken) {
		t.Fatalf("expired: %v", err)
	}
	// Another key.
	if _, err := newSigner([]byte("secret-two-secret-two-secret-two-00")).Verify(tok, now); !errors.Is(err, errBadToken) {
		t.Fatalf("other key: %v", err)
	}
	// Tampering with any byte (id, expiry, mac, version) fails.
	raw, _ := base64.RawURLEncoding.DecodeString(tok)
	for i := range raw {
		b := append([]byte(nil), raw...)
		b[i] ^= 0x01
		if _, err := s.Verify(base64.RawURLEncoding.EncodeToString(b), now); err == nil {
			t.Fatalf("tampered byte %d accepted", i)
		}
	}
	// Garbage and truncation.
	for _, bad := range []string{"", "abc", tok[:len(tok)-2], tok + "AA", strings.Repeat("A", 500), "../../etc"} {
		if _, err := s.Verify(bad, now); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	if _, err := s.Sign("not-a-uuid", now); err == nil {
		t.Fatal("signed a non-uuid")
	}
}

func TestContentDisposition(t *testing.T) {
	for in, want := range map[string]string{
		"Movie/Movie.mkv":          `inline; filename="Movie.mkv"; filename*=UTF-8''Movie.mkv`,
		`Сериал/Серия "1";.mkv`:    `inline; filename="_____ 1.mkv"; filename*=UTF-8''%D0%A1%D0%B5%D1%80%D0%B8%D1%8F%201.mkv`,
		"a\r\nX-Evil: 1/b\r\n.mp4": `inline; filename="b.mp4"; filename*=UTF-8''b.mp4`,
		"":                         "inline",
	} {
		if got := contentDisposition(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}
