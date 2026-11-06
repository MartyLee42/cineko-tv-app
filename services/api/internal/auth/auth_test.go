package auth

import (
	"context"
	"strings"
	"testing"
)

func TestPasswordHashRoundTrip(t *testing.T) {
	ctx := context.Background()
	h, err := HashPassword(ctx, "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=65536,t=2,p=2$") {
		t.Fatalf("unexpected hash format %q", h)
	}
	if ok, _ := VerifyPassword(ctx, h, "correct horse battery"); !ok {
		t.Fatal("correct password rejected")
	}
	if ok, _ := VerifyPassword(ctx, h, "wrong"); ok {
		t.Fatal("wrong password accepted")
	}
	h2, _ := HashPassword(ctx, "correct horse battery")
	if h == h2 {
		t.Fatal("hashes must be salted")
	}
	if _, err := VerifyPassword(ctx, "$bcrypt$nope", "x"); err == nil {
		t.Fatal("malformed hash should error")
	}
}

func TestValidatePassword(t *testing.T) {
	if ValidatePassword("short") == nil {
		t.Fatal("short password accepted")
	}
	if ValidatePassword(strings.Repeat("a", 257)) == nil {
		t.Fatal("overlong password accepted")
	}
	if err := ValidatePassword("long enough pw"); err != nil {
		t.Fatal(err)
	}
}

func TestTokenHashing(t *testing.T) {
	h := NewHasher([]byte("secret-one-secret-one-secret-one!"))
	tok, hash := h.NewToken(PrefixDevice)
	if !strings.HasPrefix(tok, "mtd_") || len(tok) < 40 {
		t.Fatalf("token %q", tok)
	}
	if string(h.Hash(tok)) != string(hash) {
		t.Fatal("hash must be deterministic")
	}
	other := NewHasher([]byte("secret-two-secret-two-secret-two!"))
	if string(other.Hash(tok)) == string(hash) {
		t.Fatal("hash must depend on the server secret")
	}
	if a, _ := h.NewToken(PrefixAPI); a == tok {
		t.Fatal("tokens must be random")
	}
}

func TestScopes(t *testing.T) {
	user := &Principal{Kind: KindToken, Role: RoleUser, Scopes: []string{ScopeRead, ScopeAdmin}}
	if user.HasScope(ScopeAdmin) {
		t.Fatal("non-admin token must not gain admin")
	}
	if !user.HasScope(ScopeRead) || user.HasScope(ScopeWrite) {
		t.Fatal("scope check wrong")
	}
	sess := &Principal{Kind: KindSession, Role: RoleUser}
	if !sess.HasScope(ScopeWrite) || sess.HasScope(ScopeAdmin) {
		t.Fatal("session scope check wrong")
	}
	dev := &Principal{Kind: KindDevice, Role: RoleAdmin}
	if dev.HasScope(ScopeRead) {
		t.Fatal("devices have no user scopes")
	}
}

func TestParseBearer(t *testing.T) {
	if ParseBearer("Bearer abc") != "abc" || ParseBearer("bearer  abc ") != "abc" {
		t.Fatal("bearer parse")
	}
	if ParseBearer("Pairing abc") != "" || ParseBearer("Bearer") != "" {
		t.Fatal("non-bearer accepted")
	}
}
