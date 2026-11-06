package server_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"martytv/api/internal/realtime"
	"martytv/api/internal/testutil"
)

func insertMedia(t *testing.T, env *testutil.Env) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := env.Pool.Exec(context.Background(), `INSERT INTO media (id, kind, tmdb_id) VALUES ($1, 'movie', 603)`, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestSendToTVOverWebSocket(t *testing.T) {
	env := testutil.New(t)
	alice, aliceUser := env.NewUserClient("alice", "user")
	devID, cred := env.Pair(alice, "TV")
	mediaID := insertMedia(t, env)
	phone := dialUser(t, env, alice)
	tv := dialDevice(t, env, cred)

	// Valid media.open is forwarded with a canonical payload and the sender.
	phone.send(msg{ID: "o1", Type: "media.open", Target: devID, Payload: json.RawMessage(`{"media_id":"` + mediaID + `","junk":1}`)})
	got := tv.expect("media.open")
	var fwd struct {
		Payload map[string]any `json:"payload"`
		From    *realtime.Sender
	}
	raw, _ := json.Marshal(got)
	_ = json.Unmarshal(raw, &fwd)
	if fwd.Payload["media_id"] != mediaID || fwd.Payload["junk"] != nil {
		t.Fatalf("forwarded payload %v", fwd.Payload)
	}
	if got.From == nil || got.From.UserID != aliceUser.ID || got.From.Username != "alice" {
		t.Fatalf("from %+v", got.From)
	}
	tv.send(msg{ID: "o1", Type: "ack", Payload: json.RawMessage(`{"ok":true,"result":{"screen":"details"}}`)})
	if a := phone.expect("ack"); ack(a)["ok"] != true {
		t.Fatalf("ack %+v", a)
	}

	// Bad payloads and unknown media never reach the TV.
	phone.send(msg{ID: "o2", Type: "media.open", Target: devID, Payload: json.RawMessage(`{"media_id":"x"}`)})
	if a := phone.expect("ack"); ack(a)["error"] != realtime.ErrBadPayload {
		t.Fatalf("expected bad_payload, got %+v", a)
	}
	phone.send(msg{ID: "o3", Type: "media.open", Target: devID, Payload: json.RawMessage(`{"media_id":"` + uuid.NewString() + `"}`)})
	if a := phone.expect("ack"); ack(a)["error"] != realtime.ErrNotFound {
		t.Fatalf("expected not_found, got %+v", a)
	}
	tv.expectNone("media.open", 300*time.Millisecond)

	// A client can't spoof the sender.
	phone.send(msg{ID: "o4", Type: "device.show_message", Target: devID, Payload: json.RawMessage(`{"text":"hi"}`)})
	if m := tv.expect("device.show_message"); m.From == nil || m.From.Username != "alice" {
		t.Fatalf("from %+v", m.From)
	}
}

func TestDeviceCommandAndStateHTTP(t *testing.T) {
	old := realtime.CommandTimeout
	realtime.CommandTimeout = 500 * time.Millisecond
	t.Cleanup(func() { realtime.CommandTimeout = old })

	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	devID, cred := env.Pair(alice, "TV")
	mediaID := insertMedia(t, env)
	path := "/api/v1/devices/" + devID

	// Offline TV.
	if st := alice.Do("GET", path+"/state", nil).Expect(200).JSON(); st["online"] != false || st["state"] != nil {
		t.Fatalf("state %v", st)
	}
	r := alice.Do("POST", path+"/commands", map[string]any{"type": "device.request_state"}).Expect(200).JSON()
	if r["ok"] != false || r["error"] != "device_offline" || r["id"] == "" {
		t.Fatalf("offline ack %v", r)
	}

	// Validation and access.
	alice.Do("POST", path+"/commands", map[string]any{"type": "system.reboot"}).Expect(422)
	// A bad payload is a 422 too (before the TV is even asked).
	alice.Do("POST", path+"/commands", map[string]any{"type": "playback.set_volume", "payload": map[string]any{"volume": 1.5}}).Expect(422)
	alice.Do("POST", path+"/commands", map[string]any{"type": "playback.set_volume", "payload": map[string]any{}}).Expect(422)
	// A valid one reaches the hub (offline TV → device_offline ack).
	if r := alice.Do("POST", path+"/commands", map[string]any{"type": "playback.set_volume", "payload": map[string]any{"delta": -0.1}}).Expect(200).JSON(); r["error"] != "device_offline" {
		t.Fatalf("set_volume offline ack %v", r)
	}
	bob.Do("POST", path+"/commands", map[string]any{"type": "device.request_state"}).Expect(404)
	bob.Do("GET", path+"/state", nil).Expect(404)

	// Online TV that reports state and acks.
	tv := dialDevice(t, env, cred)
	tv.send(msg{Type: "device.state", Payload: json.RawMessage(`{"screen":"home","media_id":null,"profile_id":null,"playback":null}`)})
	deadline := time.Now().Add(3 * time.Second)
	for {
		st := alice.Do("GET", path+"/state", nil).Expect(200).JSON()
		if s, _ := st["state"].(map[string]any); st["online"] == true && s != nil && s["screen"] == "home" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("state never arrived: %v", st)
		}
		time.Sleep(50 * time.Millisecond)
	}

	done := make(chan map[string]any, 1)

	// request_state over HTTP returns the TV's ack (not the cached state event).
	go func() {
		done <- alice.Do("POST", path+"/commands", map[string]any{"type": "device.request_state"}).JSON()
	}()
	rs := tv.expect("device.request_state")
	tv.send(msg{ID: rs.ID, Type: "ack", Payload: json.RawMessage(`{"ok":true,"result":{"screen":"search"}}`)})
	if res := <-done; res["ok"] != true || res["result"].(map[string]any)["screen"] != "search" {
		t.Fatalf("request_state ack %v", res)
	}

	go func() {
		done <- alice.Do("POST", path+"/commands", map[string]any{"id": "h1", "type": "media.open", "payload": map[string]string{"media_id": mediaID}}).JSON()
	}()
	cmd := tv.expect("media.open")
	tv.send(msg{ID: cmd.ID, Type: "ack", Payload: json.RawMessage(`{"ok":true,"result":{"screen":"details"}}`)})
	res := <-done
	if res["ok"] != true || res["id"] != "h1" {
		t.Fatalf("http ack %v", res)
	}
	// Same id again: answered from cache, not re-sent.
	again := alice.Do("POST", path+"/commands", map[string]any{"id": "h1", "type": "media.open", "payload": map[string]string{"media_id": mediaID}}).Expect(200).JSON()
	if again["ok"] != true {
		t.Fatalf("replay %v", again)
	}
	tv.expectNone("media.open", 300*time.Millisecond)

	// Busy TV: its error code is passed through untouched.
	go func() {
		done <- alice.Do("POST", path+"/commands", map[string]any{"type": "media.open", "payload": map[string]string{"media_id": mediaID}}).JSON()
	}()
	cmd = tv.expect("media.open")
	tv.send(msg{ID: cmd.ID, Type: "ack", Payload: json.RawMessage(`{"ok":false,"error":"busy_playing"}`)})
	if res := <-done; res["error"] != "busy_playing" {
		t.Fatalf("busy %v", res)
	}

	// TV doesn't answer → timeout ack.
	go func() {
		done <- alice.Do("POST", path+"/commands", map[string]any{"type": "media.pause"}).JSON()
	}()
	tv.expect("media.pause")
	if res := <-done; res["error"] != "timeout" {
		t.Fatalf("timeout %v", res)
	}

	// Read-only API tokens can see state but not send commands.
	tok := alice.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "r", "scopes": []string{"read"}}).Expect(201).JSON()["secret"].(string)
	bot := env.Client()
	bot.Bearer = tok
	bot.Do("GET", path+"/state", nil).Expect(200)
	bot.Do("POST", path+"/commands", map[string]any{"type": "device.request_state"}).Expect(403)
}
