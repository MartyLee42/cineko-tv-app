package pairing

import (
	"strings"
	"testing"
)

func TestUserCodes(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 2000; i++ {
		c := NewUserCode()
		if len(c) != 8 {
			t.Fatalf("len %d", len(c))
		}
		for _, r := range c {
			if !strings.ContainsRune(codeAlphabet, r) {
				t.Fatalf("bad char %q in %s", r, c)
			}
		}
		seen[c] = true
	}
	if len(seen) < 1995 {
		t.Fatalf("too many collisions: %d unique", len(seen))
	}
	for _, bad := range "01ILO" {
		if strings.ContainsRune(codeAlphabet, bad) {
			t.Fatalf("ambiguous %q in alphabet", bad)
		}
	}
}

func TestNormalizeAndFormat(t *testing.T) {
	if got := NormalizeCode(" k7qm-2xpd "); got != "K7QM2XPD" {
		t.Fatalf("normalize %q", got)
	}
	if got := FormatCode("K7QM2XPD"); got != "K7QM-2XPD" {
		t.Fatalf("format %q", got)
	}
}
