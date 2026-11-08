package alerts

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload
// encryption (RFC 8291), stdlib only.

var b64 = base64.RawURLEncoding

// decodeB64 accepts base64url with or without padding (browsers differ).
func decodeB64(s string) ([]byte, error) {
	return b64.DecodeString(strings.TrimRight(s, "="))
}

// VAPID is the server's application server key pair.
type VAPID struct {
	Private *ecdsa.PrivateKey
	// Public: base64url uncompressed point, the PWA's applicationServerKey.
	Public string
}

// NewVAPID generates a key pair.
func NewVAPID() (*VAPID, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	return vapidFrom(k)
}

func vapidFrom(k *ecdsa.PrivateKey) (*VAPID, error) {
	pub, err := k.PublicKey.Bytes()
	if err != nil {
		return nil, err
	}
	return &VAPID{Private: k, Public: b64.EncodeToString(pub)}, nil
}

// ParseVAPID loads a key pair from its stored base64url scalar.
func ParseVAPID(private string) (*VAPID, error) {
	d, err := decodeB64(private)
	if err != nil {
		return nil, err
	}
	k, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), d)
	if err != nil {
		return nil, err
	}
	return vapidFrom(k)
}

// PrivateString is the base64url scalar for storage.
func (v *VAPID) PrivateString() string {
	d, _ := v.Private.Bytes()
	return b64.EncodeToString(d)
}

// jwt signs the VAPID token for an endpoint's origin.
func (v *VAPID) jwt(aud, sub string, exp time.Time) (string, error) {
	h := b64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, _ := json.Marshal(map[string]any{"aud": aud, "exp": exp.Unix(), "sub": sub})
	in := h + "." + b64.EncodeToString(claims)
	sum := sha256.Sum256([]byte(in))
	r, s, err := ecdsa.Sign(rand.Reader, v.Private, sum[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return in + "." + b64.EncodeToString(sig), nil
}

// Subscription is a browser's PushSubscription.
type Subscription struct {
	Endpoint string
	P256dh   string // base64url uncompressed P-256 point (65 bytes)
	Auth     string // base64url 16-byte secret
}

// ValidateSubscription checks the keys and that the endpoint is a known
// push service over HTTPS (the server POSTs to it: no arbitrary hosts).
func ValidateSubscription(s Subscription) error {
	u, err := url.Parse(s.Endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || len(s.Endpoint) > 1000 {
		return errors.New("endpoint must be an https URL")
	}
	if !knownPushHost(u.Hostname()) {
		return errors.New("unknown push service")
	}
	if k, err := decodeB64(s.P256dh); err != nil || len(k) != 65 || k[0] != 4 {
		return errors.New("bad p256dh key")
	}
	if a, err := decodeB64(s.Auth); err != nil || len(a) != 16 {
		return errors.New("bad auth secret")
	}
	return nil
}

// Push services of the browsers people use (Chrome/Edge/Opera via FCM,
// Firefox, Safari / iOS, old Edge / Windows).
var pushHosts = []string{"fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com",
	"push.apple.com", "notify.windows.com"}

func knownPushHost(h string) bool {
	h = strings.ToLower(h)
	for _, s := range pushHosts {
		if h == s || strings.HasSuffix(h, "."+s) {
			return true
		}
	}
	return false
}

const recordSize = 4096

// Encrypt is RFC 8291 aes128gcm with a fresh ephemeral key and salt.
func Encrypt(sub Subscription, plaintext []byte) ([]byte, error) {
	as, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	salt := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, err
	}
	return encrypt(sub, plaintext, as, salt)
}

func encrypt(sub Subscription, plaintext []byte, as *ecdh.PrivateKey, salt []byte) ([]byte, error) {
	uaRaw, err := decodeB64(sub.P256dh)
	if err != nil {
		return nil, err
	}
	authSecret, err := decodeB64(sub.Auth)
	if err != nil {
		return nil, err
	}
	ua, err := ecdh.P256().NewPublicKey(uaRaw)
	if err != nil {
		return nil, err
	}
	if len(plaintext)+1+16 > recordSize-86 {
		return nil, errors.New("payload too large")
	}
	shared, err := as.ECDH(ua)
	if err != nil {
		return nil, err
	}
	asPub := as.PublicKey().Bytes()
	keyInfo := "WebPush: info\x00" + string(uaRaw) + string(asPub)
	ikm, err := hkdf.Key(sha256.New, shared, authSecret, keyInfo, 32)
	if err != nil {
		return nil, err
	}
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		return nil, err
	}
	cek, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	var hdr bytes.Buffer
	hdr.Write(salt)
	_ = binary.Write(&hdr, binary.BigEndian, uint32(recordSize))
	hdr.WriteByte(byte(len(asPub)))
	hdr.Write(asPub)
	padded := append(append([]byte(nil), plaintext...), 2) // last record delimiter
	return gcm.Seal(hdr.Bytes(), nonce, padded, nil), nil
}

// ErrGone: the subscription expired or was revoked (404 / 410): delete it.
var ErrGone = errors.New("push subscription gone")

// Pusher sends Web Push messages.
type Pusher struct {
	HTTP *http.Client
	// Subject: the VAPID "sub" claim (mailto: or https: URL of the server).
	Subject string
}

// Send delivers one encrypted payload.
func (p *Pusher) Send(ctx context.Context, v *VAPID, sub Subscription, payload []byte, urgency string) error {
	body, err := Encrypt(sub, payload)
	if err != nil {
		return err
	}
	u, err := url.Parse(sub.Endpoint)
	if err != nil {
		return err
	}
	tok, err := v.jwt(u.Scheme+"://"+u.Host, p.Subject, time.Now().Add(12*time.Hour))
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("TTL", "86400")
	if urgency != "" {
		req.Header.Set("Urgency", urgency)
	}
	req.Header.Set("Authorization", "vapid t="+tok+", k="+v.Public)
	client := p.HTTP
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("push request failed")
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		return ErrGone
	case resp.StatusCode >= 300:
		return fmt.Errorf("push service answered HTTP %d", resp.StatusCode)
	}
	return nil
}
