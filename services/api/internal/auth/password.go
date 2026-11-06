package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters (OWASP-recommended range). Each hash uses ~64 MiB, so
// concurrent hashing is bounded by hashSlots to protect server memory.
const (
	argonTime    = 2
	argonMemory  = 64 * 1024
	argonThreads = 2
	argonKeyLen  = 32
	argonSaltLen = 16

	MinPasswordLen = 10
	MaxPasswordLen = 256
)

var hashSlots = make(chan struct{}, 4)

var ErrInvalidHash = errors.New("invalid password hash")

// dummyHash is verified against when a username does not exist so that login
// timing does not reveal which usernames are registered.
var dummyHash = mustHash("martytv-dummy-password-for-timing")

// ValidatePassword enforces length bounds only; long passphrases are encouraged.
func ValidatePassword(pw string) error {
	n := utf8.RuneCountInString(pw)
	if n < MinPasswordLen {
		return fmt.Errorf("must be at least %d characters", MinPasswordLen)
	}
	if len(pw) > MaxPasswordLen {
		return fmt.Errorf("must be at most %d bytes", MaxPasswordLen)
	}
	return nil
}

// HashPassword returns a PHC-format argon2id hash.
func HashPassword(ctx context.Context, pw string) (string, error) {
	if err := acquire(ctx); err != nil {
		return "", err
	}
	defer release()
	return hashPassword(pw), nil
}

func hashPassword(pw string) string {
	salt := make([]byte, argonSaltLen)
	_, _ = rand.Read(salt)
	key := argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory, argonTime,
		argonThreads, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
}

func mustHash(pw string) string { return hashPassword(pw) }

// VerifyPassword checks pw against a PHC argon2id hash in constant time.
func VerifyPassword(ctx context.Context, encoded, pw string) (bool, error) {
	if len(pw) > MaxPasswordLen {
		return false, nil
	}
	if err := acquire(ctx); err != nil {
		return false, err
	}
	defer release()
	return verify(encoded, pw)
}

func verify(encoded, pw string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, ErrInvalidHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, ErrInvalidHash
	}
	var m uint32
	var t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, ErrInvalidHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, ErrInvalidHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false, ErrInvalidHash
	}
	got := argon2.IDKey([]byte(pw), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

func acquire(ctx context.Context) error {
	select {
	case hashSlots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func release() { <-hashSlots }
