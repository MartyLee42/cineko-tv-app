package server_test

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"martytv/api/internal/config"
	"martytv/api/internal/testutil"
)

const alertToken = "test-alert-token-0123456789abcdef"

func inbox(t *testing.T, c *testutil.Client) []map[string]any {
	t.Helper()
	return c.Do("GET", "/api/v1/messages", nil).Expect(200).Items()
}

// POST /internal/incident: 404 without ALERT_TOKEN, bearer only, validated.
func TestInternalIncidentAuth(t *testing.T) {
	off := testutil.New(t)
	off.Client().Do("POST", "/internal/incident", map[string]any{"kind": "vpn", "state": "down"}, "Authorization", "Bearer x").Expect(404)

	env := testutil.New(t, func(c *config.Config) { c.AlertToken = alertToken })
	c := env.Client()
	body := map[string]any{"kind": "vpn", "state": "down"}
	c.Do("POST", "/internal/incident", body).Expect(401)
	c.Do("POST", "/internal/incident", body, "Authorization", "Bearer wrong-token-0123456789abcdef").Expect(401)
	auth := []string{"Authorization", "Bearer " + alertToken}
	c.Do("POST", "/internal/incident", map[string]any{"kind": "tmdb", "state": "down"}, auth...).Expect(400)
	c.Do("POST", "/internal/incident", map[string]any{"kind": "youtube", "state": "down", "action": "rm_rf"}, auth...).Expect(400)
	c.Do("POST", "/internal/incident", map[string]any{"kind": "updater", "state": "down"}, auth...).Expect(400)
	c.Do("POST", "/internal/incident", body, auth...).Expect(202)
	// Not under /api/v1 (Caddy proxies only /api/*): there the token is just an invalid API token.
	if r := c.Do("POST", "/api/v1/internal/incident", body, auth...); r.Status != 401 && r.Status != 404 {
		t.Fatalf("/api/v1/internal/incident: %d", r.Status)
	}
}

// Host reports open and close incidents; admins (not users) get a Cineko
// message for each, and the admin list shows them.
func TestIncidentLifecycleNotifiesAdmins(t *testing.T) {
	env := testutil.New(t, func(c *config.Config) { c.AlertToken = alertToken })
	admin, _ := env.NewUserClient("boss", "admin")
	user, _ := env.NewUserClient("kid", "user")
	host := env.Client()
	auth := []string{"Authorization", "Bearer " + alertToken}

	// The watchdog restarted the companion, and YouTube still fails.
	host.Do("POST", "/internal/incident", map[string]any{"kind": "youtube", "state": "event", "action": "companion_restarted"}, auth...).Expect(202)
	host.Do("POST", "/internal/incident", map[string]any{"kind": "youtube", "state": "down", "cause": "streams"}, auth...).Expect(202)
	env.Server.Alerts.Wait()

	msgs := inbox(t, admin)
	if len(msgs) != 1 || msgs[0]["title"] != "Сбой: YouTube" || msgs[0]["from_name"] != "Cineko" ||
		!strings.Contains(msgs[0]["body"].(string), "видео не отдаёт потоки") ||
		!strings.Contains(msgs[0]["body"].(string), "Компаньон перезапущен, не помогло.") {
		t.Fatalf("admin inbox %v", msgs)
	}
	if got := inbox(t, user); len(got) != 0 {
		t.Fatalf("user got %v", got)
	}
	// Repeated "down" reports don't repeat the message.
	host.Do("POST", "/internal/incident", map[string]any{"kind": "youtube", "state": "down", "cause": "streams"}, auth...).Expect(202)
	env.Server.Alerts.Wait()
	if got := inbox(t, admin); len(got) != 1 {
		t.Fatalf("repeat: %d messages", len(got))
	}

	list := admin.Do("GET", "/api/v1/admin/incidents?lang=en", nil).Expect(200)
	items := list.Items()
	if list.JSON()["open"].(float64) != 1 || len(items) != 1 || items[0]["kind"] != "youtube" || items[0]["closed_at"] != nil ||
		items[0]["summary"] != "YouTube is down: videos have no streams" || len(items[0]["notes"].([]any)) != 1 {
		t.Fatalf("list %s", list.Body)
	}
	user.Do("GET", "/api/v1/admin/incidents", nil).Expect(403)

	host.Do("POST", "/internal/incident", map[string]any{"kind": "youtube", "state": "up"}, auth...).Expect(202)
	env.Server.Alerts.Wait()
	msgs = inbox(t, admin)
	if len(msgs) != 2 || msgs[0]["title"] != "Снова работает: YouTube" {
		t.Fatalf("recovery %v", msgs)
	}
	items = admin.Do("GET", "/api/v1/admin/incidents", nil).Expect(200).Items()
	if items[0]["closed_at"] == nil {
		t.Fatalf("not closed %v", items[0])
	}

	// Updater rollback: a one-off notice, deduplicated.
	for range 2 {
		host.Do("POST", "/internal/incident", map[string]any{"kind": "updater", "state": "event", "cause": "rollback", "detail": "companion 2026.11.07"}, auth...).Expect(202)
	}
	env.Server.Alerts.Wait()
	msgs = inbox(t, admin)
	if len(msgs) != 3 || !strings.HasPrefix(msgs[0]["body"].(string), "Обновление откатено") {
		t.Fatalf("updater %v", msgs)
	}
}

// Push opt-in: subscription validation, and a push delivered to the
// subscribed browser on an incident.
func TestIncidentWebPush(t *testing.T) {
	env := testutil.New(t, func(c *config.Config) { c.AlertToken = alertToken })
	admin, u := env.NewUserClient("boss", "admin")
	user, _ := env.NewUserClient("kid", "user")

	st := admin.Do("GET", "/api/v1/admin/alerts/push", nil).Expect(200).JSON()
	if k, _ := st["public_key"].(string); len(k) != 87 || st["subscriptions"].(float64) != 0 {
		t.Fatalf("status %v", st)
	}
	user.Do("GET", "/api/v1/admin/alerts/push", nil).Expect(403)

	ua, _ := ecdh.P256().GenerateKey(rand.Reader)
	p256 := base64.RawURLEncoding.EncodeToString(ua.PublicKey().Bytes())
	keys := map[string]string{"p256dh": p256, "auth": "BTBZMqHH6r4Tts7J_aSIgg"}
	admin.Do("POST", "/api/v1/admin/alerts/push", map[string]any{"endpoint": "https://evil.example/x", "keys": keys}).Expect(422)
	admin.Do("POST", "/api/v1/admin/alerts/push", map[string]any{"endpoint": "https://fcm.googleapis.com/fcm/send/abc", "keys": keys, "locale": "en"}).Expect(204)
	if n := admin.Do("GET", "/api/v1/admin/alerts/push", nil).Expect(200).JSON()["subscriptions"].(float64); n != 1 {
		t.Fatalf("subscriptions %v", n)
	}
	admin.Do("POST", "/api/v1/admin/alerts/push/unsubscribe", map[string]any{"endpoint": "https://fcm.googleapis.com/fcm/send/abc"}).Expect(204)

	// A fake push service (tests insert its http URL directly: the API only accepts known push hosts).
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Encoding") == "aes128gcm" && strings.HasPrefix(r.Header.Get("Authorization"), "vapid ") {
			hits.Add(1)
		}
		w.WriteHeader(201)
	}))
	defer srv.Close()
	if _, err := env.Pool.Exec(context.Background(), `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, locale)
		VALUES ($1, $2, $3, $4, 'en')`, u.ID, srv.URL+"/push/1", p256, "BTBZMqHH6r4Tts7J_aSIgg"); err != nil {
		t.Fatal(err)
	}
	env.Client().Do("POST", "/internal/incident", map[string]any{"kind": "vpn", "state": "down"}, "Authorization", "Bearer "+alertToken).Expect(202)
	env.Server.Alerts.Wait()
	if hits.Load() != 1 {
		t.Fatalf("push hits %d", hits.Load())
	}
	// The newest subscription's language picks the inbox text too.
	if msgs := inbox(t, admin); len(msgs) != 1 || msgs[0]["title"] != "Outage: VPN" {
		t.Fatalf("inbox %v", msgs)
	}
	res := admin.Do("POST", "/api/v1/admin/alerts/push/test", nil).Expect(200).JSON()
	if res["sent"].(float64) != 1 || hits.Load() != 2 {
		t.Fatalf("test push %v hits=%d", res, hits.Load())
	}
}
