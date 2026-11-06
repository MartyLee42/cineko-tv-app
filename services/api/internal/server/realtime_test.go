package server_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/fasthttp/websocket"

	"martytv/api/internal/realtime"
	"martytv/api/internal/testutil"
)

// wsConn reads messages on a goroutine into a channel. (A timed-out read
// leaves a websocket.Conn unusable, so tests never set read deadlines.)
type wsConn struct {
	t      *testing.T
	c      *websocket.Conn
	in     chan msg
	closed chan struct{}
}

func newWSConn(t *testing.T, c *websocket.Conn) *wsConn {
	w := &wsConn{t: t, c: c, in: make(chan msg, 64), closed: make(chan struct{})}
	go func() {
		defer close(w.closed)
		for {
			var m msg
			if err := c.ReadJSON(&m); err != nil {
				return
			}
			w.in <- m
		}
	}()
	t.Cleanup(func() { c.Close() })
	return w
}

type msg struct {
	ID       string           `json:"id,omitempty"`
	Type     string           `json:"type"`
	Target   string           `json:"target_device_id,omitempty"`
	DeviceID string           `json:"device_id,omitempty"`
	Payload  json.RawMessage  `json:"payload,omitempty"`
	From     *realtime.Sender `json:"from,omitempty"`
}

// dialDevice connects as a TV using first-message auth.
func dialDevice(t *testing.T, env *testutil.Env, cred string) *wsConn {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(env.WSURL(), nil)
	if err != nil {
		t.Fatal(err)
	}
	w := newWSConn(t, c)
	w.send(msg{Type: "auth", Payload: json.RawMessage(`{"token":"` + cred + `"}`)})
	w.expect("hello")
	return w
}

// dialUser connects as a browser with the client's session cookie.
func dialUser(t *testing.T, env *testutil.Env, c *testutil.Client) *wsConn {
	t.Helper()
	h := http.Header{}
	h.Set("Cookie", "mt_session="+c.SessionCookie())
	h.Set("Origin", env.Origin)
	conn, _, err := websocket.DefaultDialer.Dial(env.WSURL(), h)
	if err != nil {
		t.Fatal(err)
	}
	w := newWSConn(t, conn)
	w.expect("hello")
	return w
}

func (w *wsConn) send(m msg) {
	w.t.Helper()
	if err := w.c.WriteJSON(m); err != nil {
		w.t.Fatal(err)
	}
}

// expect waits for a message of type typ, skipping others.
func (w *wsConn) expect(typ string) msg {
	w.t.Helper()
	timeout := time.After(3 * time.Second)
	for {
		select {
		case m := <-w.in:
			if m.Type == typ {
				return m
			}
		case <-w.closed:
			w.t.Fatalf("connection closed while waiting for %q", typ)
		case <-timeout:
			w.t.Fatalf("timed out waiting for %q", typ)
		}
	}
}

// expectNone asserts no message of type typ arrives within d.
func (w *wsConn) expectNone(typ string, d time.Duration) {
	w.t.Helper()
	timeout := time.After(d)
	for {
		select {
		case m := <-w.in:
			if m.Type == typ {
				w.t.Fatalf("unexpected %q: %+v", typ, m)
			}
		case <-w.closed:
			return
		case <-timeout:
			return
		}
	}
}

func (w *wsConn) expectClosed() {
	w.t.Helper()
	select {
	case <-w.closed:
	case <-time.After(3 * time.Second):
		w.t.Fatal("connection still open")
	}
}

func ack(m msg) map[string]any {
	var a map[string]any
	_ = json.Unmarshal(m.Payload, &a)
	return a
}

func TestRealtimeRejectsBadCredentials(t *testing.T) {
	env := testutil.New(t)
	c, _, err := websocket.DefaultDialer.Dial(env.WSURL(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.WriteJSON(msg{Type: "auth", Payload: json.RawMessage(`{"token":"mtd_bogus"}`)})
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, err = c.ReadMessage()
	if !websocket.IsCloseError(err, websocket.ClosePolicyViolation) {
		t.Fatalf("expected policy-violation close, got %v", err)
	}

	// Browsers from foreign origins are refused even with a valid cookie.
	alice, _ := env.NewUserClient("alice", "user")
	h := http.Header{}
	h.Set("Cookie", "mt_session="+alice.SessionCookie())
	h.Set("Origin", "https://evil.example")
	if _, _, err := websocket.DefaultDialer.Dial(env.WSURL(), h); err == nil {
		t.Fatal("cross-origin websocket must be rejected")
	}
}

func TestRealtimePresenceAndCommands(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	devID, cred := env.Pair(alice, "TV")
	phone := dialUser(t, env, alice)

	tv := dialDevice(t, env, cred)
	pres := phone.expect("device.presence")
	if pres.DeviceID != devID || ack(pres)["online"] != true {
		t.Fatalf("presence %+v", pres)
	}
	if online := alice.Do("GET", "/api/v1/devices/"+devID, nil).JSON()["online"]; online != true {
		t.Fatal("device should be online")
	}

	// State reported by the TV reaches the phone.
	tv.send(msg{Type: "device.state", Payload: json.RawMessage(`{"screen":"home"}`)})
	if st := phone.expect("device.state"); st.DeviceID != devID {
		t.Fatalf("state %+v", st)
	}

	// Command → TV → ack → phone.
	phone.send(msg{ID: "cmd-1", Type: "device.show_message", Target: devID, Payload: json.RawMessage(`{"text":"hi"}`)})
	got := tv.expect("device.show_message")
	if got.ID != "cmd-1" {
		t.Fatalf("tv got %+v", got)
	}
	tv.send(msg{ID: "cmd-1", Type: "ack", Payload: json.RawMessage(`{"ok":true}`)})
	if a := phone.expect("ack"); a.ID != "cmd-1" || ack(a)["ok"] != true {
		t.Fatalf("ack %+v", a)
	}

	// A retried command with the same ID is answered from cache, not re-sent.
	phone.send(msg{ID: "cmd-1", Type: "device.show_message", Target: devID, Payload: json.RawMessage(`{"text":"hi"}`)})
	if a := phone.expect("ack"); a.ID != "cmd-1" || ack(a)["ok"] != true {
		t.Fatalf("replayed ack %+v", a)
	}
	tv.expectNone("device.show_message", 300*time.Millisecond)

	// Unknown command types are rejected by the server.
	phone.send(msg{ID: "x", Type: "system.shutdown", Target: devID})
	phone.expect("error")
}

func TestRealtimeCommandTimeoutAndOffline(t *testing.T) {
	old := realtime.CommandTimeout
	realtime.CommandTimeout = 300 * time.Millisecond
	t.Cleanup(func() { realtime.CommandTimeout = old })

	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	devID, cred := env.Pair(alice, "TV")
	phone := dialUser(t, env, alice)

	phone.send(msg{ID: "c1", Type: "device.request_state", Target: devID})
	if a := phone.expect("ack"); ack(a)["error"] != realtime.ErrDeviceOffline {
		t.Fatalf("expected offline, got %+v", a)
	}

	tv := dialDevice(t, env, cred)
	phone.send(msg{ID: "c2", Type: "media.pause", Target: devID})
	tv.expect("media.pause") // TV never acks
	if a := phone.expect("ack"); a.ID != "c2" || ack(a)["error"] != realtime.ErrTimeout {
		t.Fatalf("expected timeout, got %+v", a)
	}
	// Timeouts aren't cached: a retry is delivered again.
	phone.send(msg{ID: "c2", Type: "media.pause", Target: devID})
	tv.expect("media.pause")
}

func TestRealtimeAuthorization(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	devID, cred := env.Pair(alice, "TV")
	tv := dialDevice(t, env, cred)
	bobWS := dialUser(t, env, bob)

	bobWS.send(msg{ID: "b1", Type: "device.show_message", Target: devID, Payload: json.RawMessage(`{"text":"boo"}`)})
	if a := bobWS.expect("ack"); ack(a)["error"] != realtime.ErrForbidden {
		t.Fatalf("expected forbidden, got %+v", a)
	}
	tv.expectNone("device.show_message", 300*time.Millisecond)

	// Bob doesn't receive presence for devices he can't see.
	bobWS.expectNone("device.presence", 200*time.Millisecond)

	// A TV cannot ack commands addressed to other devices: acks are scoped by device.
	alice.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "bob", "permission": "control"}).Expect(200)
	bobWS.send(msg{ID: "b2", Type: "device.show_message", Target: devID, Payload: json.RawMessage(`{"text":"ok"}`)})
	tv.expect("device.show_message")
	tv.send(msg{ID: "b2", Type: "ack", Payload: json.RawMessage(`{"ok":true}`)})
	if a := bobWS.expect("ack"); ack(a)["ok"] != true {
		t.Fatalf("shared control ack %+v", a)
	}
}

func TestRealtimeReconnectAndRevocation(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	devID, cred := env.Pair(alice, "TV")
	phone := dialUser(t, env, alice)

	first := dialDevice(t, env, cred)
	phone.expect("device.presence")

	// The TV reconnects before the old socket died: the new one replaces it
	// and the device stays online (no offline flap).
	second := dialDevice(t, env, cred)
	first.expectClosed()
	phone.expectNone("device.presence", 300*time.Millisecond)

	phone.send(msg{ID: "r1", Type: "device.request_state", Target: devID})
	second.expect("device.request_state")

	// Unpairing disconnects the TV immediately and marks it offline.
	alice.Do("DELETE", "/api/v1/devices/"+devID, nil).Expect(204)
	second.expectClosed()
	if pres := phone.expect("device.presence"); ack(pres)["online"] != false {
		t.Fatalf("presence %+v", pres)
	}

	// Logging out closes the phone's socket too.
	alice.Do("POST", "/api/v1/auth/logout", nil).Expect(204)
	phone.expectClosed()
}

// With ?auth=token the socket authenticates as the TV even if a session cookie is present.
func TestRealtimeTokenAuthIgnoresCookie(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	devID, cred := env.Pair(alice, "TV")
	h := http.Header{}
	h.Set("Cookie", "mt_session="+alice.SessionCookie())
	h.Set("Origin", env.Origin)
	c, _, err := websocket.DefaultDialer.Dial(env.WSURL()+"?auth=token", h)
	if err != nil {
		t.Fatal(err)
	}
	w := newWSConn(t, c)
	w.send(msg{Type: "auth", Payload: json.RawMessage(`{"token":"` + cred + `"}`)})
	hello := w.expect("hello")
	var p map[string]any
	_ = json.Unmarshal(hello.Payload, &p)
	if p["kind"] != "device" || p["device_id"] != devID {
		t.Fatalf("hello %v", p)
	}
}
