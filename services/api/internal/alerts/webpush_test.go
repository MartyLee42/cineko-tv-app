package alerts

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// RFC 8291 Appendix A.
func TestEncryptRFC8291Vector(t *testing.T) {
	asPriv, _ := decodeB64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")
	as, err := ecdh.P256().NewPrivateKey(asPriv)
	if err != nil {
		t.Fatal(err)
	}
	if got := b64.EncodeToString(as.PublicKey().Bytes()); got != "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8" {
		t.Fatalf("as_public %s", got)
	}
	salt, _ := decodeB64("DGv6ra1nlYgDCS1FRnbzlw")
	sub := Subscription{
		P256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
		Auth:   "BTBZMqHH6r4Tts7J_aSIgg",
	}
	out, err := encrypt(sub, []byte("When I grow up, I want to be a watermelon"), as, salt)
	if err != nil {
		t.Fatal(err)
	}
	want := "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
	if got := b64.EncodeToString(out); got != want {
		t.Fatalf("ciphertext\n got %s\nwant %s", got, want)
	}
}

func TestVAPIDRoundTripAndJWT(t *testing.T) {
	v, err := NewVAPID()
	if err != nil {
		t.Fatal(err)
	}
	v2, err := ParseVAPID(v.PrivateString())
	if err != nil || v2.Public != v.Public {
		t.Fatalf("parse: %v %s %s", err, v2.Public, v.Public)
	}
	tok, err := v.jwt("https://fcm.googleapis.com", "mailto:x@example.org", fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatal(tok)
	}
	sig, _ := decodeB64(parts[2])
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r, s := new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(&v.Private.PublicKey, sum[:], r, s) {
		t.Fatal("signature doesn't verify")
	}
}

func TestValidateSubscription(t *testing.T) {
	good := Subscription{Endpoint: "https://fcm.googleapis.com/fcm/send/abc",
		P256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", Auth: "BTBZMqHH6r4Tts7J_aSIgg"}
	if err := ValidateSubscription(good); err != nil {
		t.Fatal(err)
	}
	for _, ep := range []string{"http://fcm.googleapis.com/x", "https://evil.example/x", "https://169.254.169.254/x", "https://fcm.googleapis.com.evil.example/x"} {
		s := good
		s.Endpoint = ep
		if ValidateSubscription(s) == nil {
			t.Errorf("%s accepted", ep)
		}
	}
	for _, ep := range []string{"https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x"} {
		s := good
		s.Endpoint = ep
		if err := ValidateSubscription(s); err != nil {
			t.Errorf("%s: %v", ep, err)
		}
	}
	s := good
	s.Auth = "AAAA"
	if ValidateSubscription(s) == nil {
		t.Error("short auth accepted")
	}
}

func TestPusherSend(t *testing.T) {
	v, _ := NewVAPID()
	var got *http.Request
	var body []byte
	status := 201
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		body, _ = io.ReadAll(r.Body)
		w.WriteHeader(status)
	}))
	defer srv.Close()
	ua, _ := ecdh.P256().GenerateKey(rand.Reader)
	sub := Subscription{Endpoint: srv.URL + "/push/1", P256dh: b64.EncodeToString(ua.PublicKey().Bytes()), Auth: "BTBZMqHH6r4Tts7J_aSIgg"}
	p := &Pusher{HTTP: srv.Client(), Subject: "mailto:x@example.org"}
	if err := p.Send(context.Background(), v, sub, []byte(`{"title":"x"}`), "high"); err != nil {
		t.Fatal(err)
	}
	if got.Header.Get("Content-Encoding") != "aes128gcm" || !strings.HasPrefix(got.Header.Get("Authorization"), "vapid t=") ||
		!strings.HasSuffix(got.Header.Get("Authorization"), ", k="+v.Public) || got.Header.Get("TTL") == "" || len(body) < 86 {
		t.Fatalf("request %v len=%d", got.Header, len(body))
	}
	status = 410
	if err := p.Send(context.Background(), v, sub, []byte(`{}`), ""); err != ErrGone {
		t.Fatalf("410: %v", err)
	}
}
