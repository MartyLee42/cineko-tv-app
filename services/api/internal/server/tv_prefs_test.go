package server_test

import (
	"testing"

	"martytv/api/internal/testutil"
)

// A paired TV reads the profile's playback preferences (so its player picks
// the preferred voice-over) but cannot change them; another user's TV can't
// read them at all.
func TestTVReadsProfilePreferences(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")

	id := alice.Do("POST", "/api/v1/profiles", map[string]any{"name": "Alice", "color": "#6366f1"}).Expect(201).JSON()["id"].(string)
	prefs := alice.Do("GET", "/api/v1/profiles/"+id+"/preferences", nil).Expect(200).JSON()
	prefs["preferred_voiceovers"] = []string{"LostFilm"}
	alice.Do("PUT", "/api/v1/profiles/"+id+"/preferences", prefs).Expect(200)

	_, cred := env.Pair(alice, "TV")
	tv := env.Client()
	tv.Bearer = cred
	got := tv.Do("GET", "/api/v1/profiles/"+id+"/preferences", nil).Expect(200).JSON()
	if vo, _ := got["preferred_voiceovers"].([]any); len(vo) != 1 || vo[0] != "LostFilm" {
		t.Fatalf("tv prefs %v", got["preferred_voiceovers"])
	}
	tv.Do("PUT", "/api/v1/profiles/"+id+"/preferences", prefs).Expect(403)

	_, bobCred := env.Pair(bob, "Bob TV")
	other := env.Client()
	other.Bearer = bobCred
	other.Do("GET", "/api/v1/profiles/"+id+"/preferences", nil).Expect(404)
}
