package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"
)

// Opaque credential prefixes. The prefix tells the server (and secret
// scanners) what kind of credential it is.
const (
	PrefixSession = "mts_"
	PrefixAPI     = "mtp_"
	PrefixDevice  = "mtd_"
)

// Hasher derives the value stored in the database for an opaque token:
// HMAC-SHA256 keyed with APP_SESSION_SECRET. A database leak alone is not
// enough to forge or replay credentials. Rotating the secret invalidates all
// sessions, API tokens and device credentials.
type Hasher struct{ key []byte }

func NewHasher(secret []byte) *Hasher { return &Hasher{key: secret} }

func (h *Hasher) Hash(token string) []byte {
	m := hmac.New(sha256.New, h.key)
	m.Write([]byte(token))
	return m.Sum(nil)
}

// NewToken returns a random token with the given prefix and its stored hash.
func (h *Hasher) NewToken(prefix string) (string, []byte) {
	t := prefix + RandomString(32)
	return t, h.Hash(t)
}

// RandomString returns n random bytes encoded as unpadded base64url.
func RandomString(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// DisplayPrefix returns a short non-secret prefix to help users tell tokens apart.
func DisplayPrefix(token string) string {
	if len(token) > 12 {
		return token[:12]
	}
	return token
}

// ParseBearer extracts a token from an Authorization header.
func ParseBearer(header string) string {
	const p = "Bearer "
	if len(header) > len(p) && strings.EqualFold(header[:len(p)], p) {
		return strings.TrimSpace(header[len(p):])
	}
	return ""
}
