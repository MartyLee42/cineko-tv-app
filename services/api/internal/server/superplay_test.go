package server_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"martytv/api/internal/realtime"
	"martytv/api/internal/testutil"
)

// A super_admin may play on (and read the state of) anyone's TV; the role
// counts as `control`, every such command is audited, admins and users can't.
func TestSuperAdminPlaysOnAnyDevice(t *testing.T) {
	old := realtime.CommandTimeout
	realtime.CommandTimeout = 2 * time.Second
	t.Cleanup(func() { realtime.CommandTimeout = old })

	env := testutil.New(t)
	super, superUser := env.NewUserClient("marty", "super_admin")
	admin, _ := env.NewUserClient("adam", "admin")
	alice, aliceUser := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	devID, cred := env.Pair(alice, "Alice TV")
	mediaID := insertMedia(t, env)
	path := "/api/v1/devices/" + devID
	tv := dialDevice(t, env, cred)
	tv.send(msg{Type: "device.state", Payload: json.RawMessage(`{"screen":"home","media_id":null,"profile_id":null,"playback":null}`)})

	// State is readable over HTTP.
	deadline := time.Now().Add(3 * time.Second)
	for {
		st := super.Do("GET", path+"/state", nil).Expect(200).JSON()
		if s, _ := st["state"].(map[string]any); st["online"] == true && s != nil && s["screen"] == "home" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("state never arrived: %v", st)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// media.play over the socket reaches the TV with the super_admin as sender.
	sock := dialUser(t, env, super)
	play := json.RawMessage(`{"media_id":"` + mediaID + `"}`)
	sock.send(msg{ID: "p1", Type: "media.play", Target: devID, Payload: play})
	got := tv.expect("media.play")
	if got.From == nil || got.From.UserID != superUser.ID {
		t.Fatalf("from %+v", got.From)
	}
	tv.send(msg{ID: "p1", Type: "ack", Payload: json.RawMessage(`{"ok":true,"result":{"screen":"player"}}`)})
	if a := sock.expect("ack"); ack(a)["ok"] != true {
		t.Fatalf("ack %+v", a)
	}
	// The socket now follows the TV's live state like the owner's does.
	tv.send(msg{Type: "device.state", Payload: json.RawMessage(`{"screen":"player","media_id":"` + mediaID + `","profile_id":null,"playback":null}`)})
	if m := sock.expect("device.state"); m.DeviceID != devID {
		t.Fatalf("state event %+v", m)
	}

	// The HTTP path too.
	done := make(chan map[string]any, 1)
	go func() {
		done <- super.Do("POST", path+"/commands", map[string]any{"id": "h1", "type": "media.pause"}).JSON()
	}()
	cmd := tv.expect("media.pause")
	tv.send(msg{ID: cmd.ID, Type: "ack", Payload: json.RawMessage(`{"ok":true}`)})
	if r := <-done; r["ok"] != true {
		t.Fatalf("http ack %v", r)
	}

	// A plain admin and a user: forbidden over the socket, invisible over HTTP.
	for _, c := range []*testutil.Client{admin, bob} {
		ws := dialUser(t, env, c)
		ws.send(msg{ID: "x1", Type: "media.play", Target: devID, Payload: play})
		if a := ws.expect("ack"); ack(a)["error"] != realtime.ErrForbidden {
			t.Fatalf("expected forbidden, got %+v", a)
		}
		c.Do("POST", path+"/commands", map[string]any{"type": "media.play", "payload": map[string]string{"media_id": mediaID}}).Expect(404)
		c.Do("GET", path+"/state", nil).Expect(404)
	}
	tv.expectNone("media.play", 300*time.Millisecond)

	// Audited: media.play and media.pause, with the owner; request_state and
	// the owner's own commands are not.
	alice.Do("POST", path+"/commands", map[string]any{"type": "device.request_state"})
	var n int
	if err := env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events
		WHERE action = 'admin.device_command' AND user_id = $1 AND device_id = $2
		  AND metadata->>'owner_user_id' = $3 AND metadata->>'type' IN ('media.play', 'media.pause')`,
		superUser.ID, devID, aliceUser.ID).Scan(&n); err != nil || n != 2 {
		t.Fatalf("audit %d %v", n, err)
	}
	if err := env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events
		WHERE action = 'admin.device_command'`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("audit total %d %v", n, err)
	}

	// A device shared with the super_admin is used through the share: no audit.
	alice.Do("PUT", path+"/permissions", map[string]string{"username": "marty", "permission": "control"}).Expect(200)
	sock.send(msg{ID: "p2", Type: "media.stop", Target: devID})
	tv.expect("media.stop")
	tv.send(msg{ID: "p2", Type: "ack", Payload: json.RawMessage(`{"ok":true}`)})
	sock.expect("ack")
	if err := env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events
		WHERE action = 'admin.device_command'`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("audit after share %d %v", n, err)
	}
}

// GET /devices?scope=all: super_admin only; own and shared first, everyone
// else's with owner and via=admin. The plain list is unchanged.
func TestDevicesScopeAll(t *testing.T) {
	env := testutil.New(t)
	super, superUser := env.NewUserClient("marty", "super_admin")
	admin, _ := env.NewUserClient("adam", "admin")
	alice, aliceUser := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	mine, _ := env.Pair(super, "Marty TV")
	aliceTV, _ := env.Pair(alice, "Alice TV")
	bobTV, _ := env.Pair(bob, "Bob TV")
	bob.Do("PUT", "/api/v1/devices/"+bobTV+"/permissions", map[string]string{"username": "marty", "permission": "use"}).Expect(200)

	if l := super.Do("GET", "/api/v1/devices", nil).Expect(200).Items(); len(l) != 2 || l[0]["owner"] != nil || l[0]["via"] != nil {
		t.Fatalf("plain list %v", l)
	}
	all := super.Do("GET", "/api/v1/devices?scope=all", nil).Expect(200).Items()
	if len(all) != 3 || all[0]["id"] != mine || all[1]["id"] != bobTV || all[2]["id"] != aliceTV {
		t.Fatalf("order %v", all)
	}
	if all[0]["access"] != "owner" || all[0]["via"] != nil || all[0]["owner"].(map[string]any)["id"] != superUser.ID {
		t.Fatalf("own %v", all[0])
	}
	if all[1]["access"] != "use" || all[1]["via"] != nil {
		t.Fatalf("shared %v", all[1])
	}
	o := all[2]["owner"].(map[string]any)
	if all[2]["access"] != "control" || all[2]["via"] != "admin" || o["id"] != aliceUser.ID || o["username"] != "alice" ||
		all[2]["owner_username"] != "alice" {
		t.Fatalf("other %v", all[2])
	}
	if _, ok := o["display_name"]; !ok {
		t.Fatalf("owner %v", o)
	}
	if _, ok := all[2]["online"]; !ok {
		t.Fatalf("online missing %v", all[2])
	}

	admin.Do("GET", "/api/v1/devices?scope=all", nil).Expect(403)
	alice.Do("GET", "/api/v1/devices?scope=all", nil).Expect(403)
	super.Do("GET", "/api/v1/devices?scope=bogus", nil).Expect(422)
	// The device detail and owner-only routes are not opened up.
	super.Do("GET", "/api/v1/devices/"+aliceTV, nil).Expect(404)
	super.Do("PATCH", "/api/v1/devices/"+aliceTV, map[string]string{"name": "x"}).Expect(404)
}
