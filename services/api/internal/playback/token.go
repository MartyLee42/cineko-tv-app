package playback

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"time"

	"github.com/google/uuid"
)

// Stream tokens are opaque, signed, expiring capabilities for one source:
//
//	base64url( 0x01 | source uuid (16) | expiry unix seconds (8, big endian) | HMAC-SHA256 (32) )
//
// The HMAC key is derived from APP_SESSION_SECRET with a dedicated label, so
// it cannot be confused with any other MAC the server computes.

const tokenVersion = 1

var (
	errBadToken     = errors.New("invalid stream token")
	errExpiredToken = errors.New("expired stream token")
)

type signer struct{ key []byte }

func newSigner(secret []byte) *signer {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("martytv/playback/stream-token/v1"))
	return &signer{key: m.Sum(nil)}
}

func (s *signer) mac(payload []byte) []byte {
	m := hmac.New(sha256.New, s.key)
	m.Write(payload)
	return m.Sum(nil)
}

// Sign issues a token for sourceID valid until exp.
func (s *signer) Sign(sourceID string, exp time.Time) (string, error) {
	id, err := uuid.Parse(sourceID)
	if err != nil {
		return "", err
	}
	buf := make([]byte, 0, 1+16+8+32)
	buf = append(buf, tokenVersion)
	buf = append(buf, id[:]...)
	buf = binary.BigEndian.AppendUint64(buf, uint64(exp.Unix()))
	buf = append(buf, s.mac(buf)...)
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// Verify checks the MAC (constant time) and expiry and returns the source id.
func (s *signer) Verify(token string, now time.Time) (string, error) {
	if len(token) > 128 {
		return "", errBadToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 1+16+8+32 || raw[0] != tokenVersion {
		return "", errBadToken
	}
	payload, sum := raw[:25], raw[25:]
	if !hmac.Equal(sum, s.mac(payload)) {
		return "", errBadToken
	}
	exp := int64(binary.BigEndian.Uint64(payload[17:25]))
	if now.Unix() >= exp {
		return "", errExpiredToken
	}
	var id uuid.UUID
	copy(id[:], payload[1:17])
	return id.String(), nil
}
