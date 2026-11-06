package server_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/realtime"
	"martytv/api/internal/testutil"
)

// fakeIPTV serves an iptv-org-like country playlist, channels.json, a
// gzipped XMLTV guide, a sliding live HLS channel, a channel that needs a
// User-Agent, a plain MPEG-TS channel, a dead channel and a logo.
type fakeIPTV struct {
	srv     *httptest.Server
	seq     atomic.Int32
	uaSeen  atomic.Value
	plHits  atomic.Int32
	epgHits atomic.Int32
	badLogo atomic.Int32
}

var pngBytes = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 64)...)

func newFakeIPTV(t *testing.T) *fakeIPTV {
	f := &fakeIPTV{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := f.srv.URL
		switch p := r.URL.Path; {
		case p == "/countries/ru.m3u":
			f.plHits.Add(1)
			fmt.Fprintf(w, "#EXTM3U\n"+
				"#EXTINF:-1 tvg-id=\"2x2.ru@SD\" tvg-logo=\"%[1]s/logo.png\" group-title=\"Entertainment\",2x2 (576i)\n%[1]s/live/2x2/master.m3u8\n"+
				"#EXTINF:-1 tvg-id=\"NTV.ru@SD\" group-title=\"News\",NTV (720p)\n#EXTVLCOPT:http-user-agent=TestUA/1.0\n%[1]s/live/ntv/master.m3u8\n"+
				"#EXTINF:-1 tvg-id=\"TS.ru@SD\" group-title=\"Movies\",TS Kino\n%[1]s/ts/kino\n"+
				"#EXTINF:-1 tvg-id=\"Dead.ru@SD\" group-title=\"News\",Dead [Not 24/7]\n%[1]s/dead/index.m3u8\n"+
				"#EXTINF:-1 tvg-id=\"2x2.ru@SD\" group-title=\"Entertainment\",2x2 duplicate\n%[1]s/other.m3u8\n", base)
		case p == "/channels.json":
			_, _ = io.WriteString(w, `[{"id":"2x2.ru","name":"2x2","alt_names":["Дважды два"]},{"id":"NTV.ru","name":"NTV","alt_names":["НТВ"]},{"id":"X.us","name":"X","alt_names":[]}]`)
		case p == "/epg_RU.xml.gz":
			f.epgHits.Add(1)
			now := time.Now().UTC()
			ts := func(d time.Duration) string {
				return now.Add(d).In(time.FixedZone("MSK", 3*3600)).Format("20060102150405 -0700")
			}
			doc := `<?xml version="1.0" encoding="UTF-8"?><tv>` +
				`<channel id="2x2.ru"><display-name>2x2</display-name></channel>` +
				`<channel id="77"><display-name>НТВ</display-name></channel>` +
				`<channel id="99"><display-name>Unrelated</display-name></channel>` +
				`<programme start="` + ts(-72*time.Hour) + `" stop="` + ts(-71*time.Hour) + `" channel="2x2.ru"><title>Old</title></programme>` +
				`<programme start="` + ts(-30*time.Minute) + `" stop="` + ts(30*time.Minute) + `" channel="2x2.ru"><title>Now show</title><desc>About now</desc></programme>` +
				`<programme start="` + ts(30*time.Minute) + `" stop="` + ts(90*time.Minute) + `" channel="2x2.ru"><title>Next show</title></programme>` +
				`<programme start="` + ts(120*time.Hour) + `" stop="` + ts(121*time.Hour) + `" channel="2x2.ru"><title>Far</title></programme>` +
				`<programme start="` + ts(-10*time.Minute) + `" stop="` + ts(50*time.Minute) + `" channel="77"><title>Новости</title></programme>` +
				`<programme start="` + ts(-10*time.Minute) + `" stop="` + ts(50*time.Minute) + `" channel="99"><title>Skip</title></programme>` +
				`</tv>`
			zw := gzip.NewWriter(w)
			_, _ = io.WriteString(zw, doc)
			_ = zw.Close()
		case p == "/live/2x2/master.m3u8":
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = io.WriteString(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nv/index.m3u8\n")
		case p == "/live/2x2/v/index.m3u8":
			n := f.seq.Add(1)
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			fmt.Fprintf(w, "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:%d\n#EXTINF:4,\nseg-%d.ts\n#EXTINF:4,\nseg-%d.ts\n", n, n, n+1)
		case strings.HasPrefix(p, "/live/2x2/v/seg-"):
			w.Header().Set("Content-Type", "video/mp2t")
			_, _ = w.Write(bytes.Repeat([]byte{0x47, 1, 2, 3}, 47))
		case p == "/live/ntv/master.m3u8":
			f.uaSeen.Store(r.UserAgent())
			if r.UserAgent() != "TestUA/1.0" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.Header().Set("Content-Type", "application/x-mpegURL")
			_, _ = io.WriteString(w, "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:4,\n"+base+"/seg/ntv-7.ts\n")
		case p == "/ts/kino":
			w.Header().Set("Content-Type", "video/mp2t")
			_, _ = w.Write(bytes.Repeat([]byte{0x47, 9, 9, 9}, 470))
		case p == "/logo.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
		case p == "/mine2.m3u":
			fmt.Fprintf(w, "#EXTM3U\n#EXTINF:-1 tvg-id=\"2x2.ru\",2x2\n%[1]s/live/2x2/master.m3u8\n"+
				"#EXTINF:-1 tvg-name=\"НТВ\",NTV\n%[1]s/live/ntv/master.m3u8\n"+
				"#EXTINF:-1 tvg-logo=\"%[1]s/badlogo.png\",Bad logo\n%[1]s/ts/kino\n", base)
		case p == "/badlogo.png":
			f.badLogo.Add(1)
			w.WriteHeader(http.StatusNotFound)
		case p == "/gA.xml" || p == "/gB.xml.gz":
			now := time.Now().UTC()
			ts := func(d time.Duration) string { return now.Add(d).Format("20060102150405 +0000") }
			prog := func(ch, title string) string {
				return `<programme start="` + ts(-time.Hour) + `" stop="` + ts(time.Hour) + `" channel="` + ch + `"><title>` + title + `</title></programme>`
			}
			doc := `<tv><channel id="2x2.ru"><display-name>2x2</display-name></channel>`
			if p == "/gA.xml" {
				doc += prog("2x2.ru", "From A") + `</tv>`
				_, _ = io.WriteString(w, doc)
				return
			}
			doc += `<channel id="n"><display-name>НТВ</display-name></channel>` + prog("2x2.ru", "From B") + prog("n", "B news") + `</tv>`
			zw := gzip.NewWriter(w)
			_, _ = io.WriteString(zw, doc)
			_ = zw.Close()
		case p == "/mine.m3u":
			fmt.Fprintf(w, "#EXTM3U url-tvg=\"%[1]s/none.xml\"\n#EXTINF:-1 group-title=\"Новости\",Мой канал\n%[1]s/live/2x2/master.m3u8\n", base)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func newIPTVEnv(t *testing.T) (*testutil.Env, *fakeIPTV) {
	f := newFakeIPTV(t)
	env := testutil.New(t, func(c *config.Config) {
		c.IPTV.OrgBaseURL = f.srv.URL
		c.IPTV.OrgAPIURL = f.srv.URL
		c.IPTV.OrgEPGURL = f.srv.URL + "/epg_{CC}.xml.gz"
		c.IPTV.AllowPrivate = true // the fakes listen on loopback
		c.IPTV.ProxyURL = nil
		c.Catalog.ImageCacheDir = t.TempDir()
	})
	t.Cleanup(env.Server.IPTV.Wait)
	return env, f
}

func chanByName(t *testing.T, items []map[string]any, name string) map[string]any {
	t.Helper()
	for _, it := range items {
		if it["name"] == name {
			return it
		}
	}
	t.Fatalf("channel %q not in %v", name, items)
	return nil
}

func names(items []map[string]any) []string {
	var out []string
	for _, it := range items {
		out = append(out, it["name"].(string))
	}
	return out
}

func TestIPTVPlaylistsGuideAndPrefs(t *testing.T) {
	env, f := newIPTVEnv(t)
	admin, _ := env.NewUserClient("iptvadmin", "admin")
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")

	// Only admins manage playlists.
	alice.Do("GET", "/api/v1/admin/iptv/playlists", nil).Expect(403)
	alice.Do("POST", "/api/v1/admin/iptv/playlists", map[string]any{"kind": "iptv_org_country", "country": "ru"}).Expect(403)
	admin.Do("POST", "/api/v1/admin/iptv/playlists", map[string]any{"kind": "iptv_org_country"}).Expect(422)
	admin.Do("POST", "/api/v1/admin/iptv/playlists", map[string]any{"kind": "iptv_org_country", "country": "zz"}).Expect(422)
	admin.Do("POST", "/api/v1/admin/iptv/playlists", map[string]any{"kind": "m3u_url", "url": "ftp://x"}).Expect(422)

	pl := admin.Do("POST", "/api/v1/admin/iptv/playlists", map[string]any{"kind": "iptv_org_country", "country": "RU"}).Expect(201).JSON()
	if pl["name"] != "iptv-org: Россия" || pl["country"] != "ru" {
		t.Fatalf("created %v", pl)
	}
	env.Server.IPTV.Wait()
	admin.Do("POST", "/api/v1/admin/iptv/playlists", map[string]any{"kind": "iptv_org_country", "country": "ru"}).Expect(409)

	list := admin.Do("GET", "/api/v1/admin/iptv/playlists", nil).Expect(200).JSON()
	got := list["items"].([]any)[0].(map[string]any)
	refresh, epg, st := got["refresh"].(map[string]any), got["epg"].(map[string]any), got["stats"].(map[string]any)
	if refresh["status"] != "ok" || refresh["fetched_via"] != "direct" || epg["status"] != "ok" {
		t.Fatalf("status %v %v", refresh, epg)
	}
	if st["channels"] != 4.0 || st["epg_matched"] != 2.0 || st["with_programmes"] != 2.0 || epg["programmes"] != 3.0 || epg["xmltv_channels"] != 3.0 {
		t.Fatalf("stats %v epg %v", st, epg)
	}
	if !strings.HasSuffix(got["effective_epg_url"].(string), "/epg_RU.xml.gz") {
		t.Fatalf("effective epg %v", got["effective_epg_url"])
	}
	var audits int
	_ = env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events WHERE action = 'iptv.playlist_created'`).Scan(&audits)
	if audits != 1 {
		t.Fatalf("audit rows %d", audits)
	}

	// Manual refresh: 202, re-fetches, ids stay stable.
	before := alice.Do("GET", "/api/v1/iptv/channels", nil).Expect(200).Items()
	admin.Do("POST", "/api/v1/admin/iptv/playlists/"+pl["id"].(string)+"/refresh", nil).Expect(202)
	env.Server.IPTV.Wait()
	if f.plHits.Load() != 2 || f.epgHits.Load() != 2 {
		t.Fatalf("refresh hits %d/%d", f.plHits.Load(), f.epgHits.Load())
	}
	after := alice.Do("GET", "/api/v1/iptv/channels", nil).Expect(200).Items()
	if chanByName(t, before, "NTV")["id"] != chanByName(t, after, "NTV")["id"] {
		t.Fatal("channel id changed across refreshes")
	}

	ap := alice.Do("POST", "/api/v1/profiles", map[string]string{"name": "Alice"}).Expect(201).JSON()["id"].(string)
	bp := bob.Do("POST", "/api/v1/profiles", map[string]string{"name": "Bob"}).Expect(201).JSON()["id"].(string)
	alice.Do("GET", "/api/v1/iptv/channels?profile_id="+bp, nil).Expect(404)
	env.Client().Do("GET", "/api/v1/iptv/channels", nil).Expect(401)

	res := alice.Do("GET", "/api/v1/iptv/channels?profile_id="+ap, nil).Expect(200).JSON()
	items := alice.Do("GET", "/api/v1/iptv/channels?profile_id="+ap, nil).Expect(200).Items()
	if strings.Join(names(items), ",") != "2x2,NTV,TS Kino,Dead" {
		t.Fatalf("names %v", names(items))
	}
	x2 := chanByName(t, items, "2x2")
	ntv := chanByName(t, items, "NTV")
	tsk := chanByName(t, items, "TS Kino")
	dead := chanByName(t, items, "Dead")
	if x2["number"] != 1.0 || x2["group_id"] != "entertainment" || x2["has_epg"] != true || x2["logo_url"] == nil {
		t.Fatalf("2x2 %v", x2)
	}
	if now, _ := x2["now"].(map[string]any); now == nil || now["title"] != "Now show" || now["description"] != "About now" {
		t.Fatalf("now %v", x2["now"])
	}
	if next, _ := x2["next"].(map[string]any); next == nil || next["title"] != "Next show" {
		t.Fatalf("next %v", x2["next"])
	}
	if now, _ := ntv["now"].(map[string]any); now == nil || now["title"] != "Новости" { // matched via the iptv-org alt name «НТВ»
		t.Fatalf("ntv now %v", ntv["now"])
	}
	if groups := res["groups"].([]any); len(groups) != 3 || groups[0].(map[string]any)["id"] != "entertainment" {
		t.Fatalf("groups %v", groups)
	}

	// Logos are public, proxied and cached.
	lr := env.Client().Do("GET", x2["logo_url"].(string), nil).Expect(200)
	if lr.Header.Get("Content-Type") != "image/png" || !bytes.Equal(lr.Body, pngBytes) {
		t.Fatalf("logo %s %d", lr.Header.Get("Content-Type"), len(lr.Body))
	}

	// Per-profile favorites, hidden, numbers and order.
	with := func(kv ...any) map[string]any {
		m := map[string]any{"profile_id": ap}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i].(string)] = kv[i+1]
		}
		return m
	}
	alice.Do("PATCH", "/api/v1/iptv/channels/"+ntv["id"].(string)+"/prefs", with("favorite", true)).Expect(200)
	bob.Do("PATCH", "/api/v1/iptv/channels/"+ntv["id"].(string)+"/prefs", with("favorite", true)).Expect(404) // alice's profile
	alice.Do("PATCH", "/api/v1/iptv/channels/"+dead["id"].(string)+"/prefs", with("hidden", true)).Expect(200)
	upd := alice.Do("PATCH", "/api/v1/iptv/channels/"+tsk["id"].(string)+"/prefs", with("number", 10)).Expect(200).JSON()
	if upd["number"] != 10.0 || upd["custom_number"] != 10.0 {
		t.Fatalf("number %v", upd)
	}
	alice.Do("PATCH", "/api/v1/iptv/channels/"+tsk["id"].(string)+"/prefs", with("number", 0)).Expect(422)
	items = alice.Do("GET", "/api/v1/iptv/channels?profile_id="+ap, nil).Expect(200).Items()
	if strings.Join(names(items), ",") != "2x2,NTV,TS Kino" || chanByName(t, items, "TS Kino")["number"] != 10.0 {
		t.Fatalf("after prefs %v", items)
	}
	fav := alice.Do("GET", "/api/v1/iptv/channels?group=favorites&profile_id="+ap, nil).Expect(200).Items()
	if len(fav) != 1 || fav[0]["name"] != "NTV" || fav[0]["favorite"] != true {
		t.Fatalf("favorites %v", fav)
	}
	if all := alice.Do("GET", "/api/v1/iptv/channels?include_hidden=true&profile_id="+ap, nil).Expect(200).Items(); len(all) != 4 {
		t.Fatalf("include_hidden %d", len(all))
	}
	if other := bob.Do("GET", "/api/v1/iptv/channels?profile_id="+bp, nil).Expect(200).Items(); len(other) != 4 || other[1]["favorite"] != false {
		t.Fatal("prefs leaked to another profile")
	}
	if q := alice.Do("GET", "/api/v1/iptv/channels?q=%D0%BD%D1%82%D0%B2&profile_id="+ap, nil).Expect(200).Items(); len(q) != 1 || q[0]["name"] != "NTV" {
		t.Fatalf("search нтв %v", q) // alt name
	}
	if q := alice.Do("GET", "/api/v1/iptv/channels?q=10&profile_id="+ap, nil).Expect(200).Items(); len(q) != 1 || q[0]["name"] != "TS Kino" {
		t.Fatalf("search by number %v", q)
	}
	alice.Do("PUT", "/api/v1/iptv/order", map[string]any{"profile_id": ap, "channel_ids": []string{tsk["id"].(string), ntv["id"].(string)}}).Expect(204)
	items = alice.Do("GET", "/api/v1/iptv/channels?profile_id="+ap, nil).Expect(200).Items()
	if strings.Join(names(items), ",") != "NTV,2x2,TS Kino" { // TS keeps its custom number 10, so it sorts last
		t.Fatalf("order %v", names(items))
	}

	// EPG and guide.
	epgItems := alice.Do("GET", "/api/v1/iptv/channels/"+x2["id"].(string)+"/epg", nil).Expect(200).Items()
	if len(epgItems) != 2 || epgItems[0]["title"] != "Now show" {
		t.Fatalf("epg %v", epgItems)
	}
	alice.Do("GET", "/api/v1/iptv/channels/"+x2["id"].(string)+"/epg?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z", nil).Expect(422)
	guide := alice.Do("GET", "/api/v1/iptv/guide?limit=2&profile_id="+ap, nil).Expect(200).JSON()
	if guide["total"] != 3.0 || len(guide["items"].([]any)) != 2 {
		t.Fatalf("guide %v", guide)
	}

	// Profile playlist selection.
	alice.Do("PUT", "/api/v1/profiles/"+ap+"/settings", map[string]any{"iptv_playlists": []string{"6f1c1f9e-1111-4111-8111-111111111111"}}).Expect(422)
	alice.Do("PUT", "/api/v1/profiles/"+ap+"/settings", map[string]any{"iptv_playlists": []string{}}).Expect(200)
	if n := alice.Do("GET", "/api/v1/iptv/channels?profile_id="+ap, nil).Expect(200).Items(); len(n) != 0 {
		t.Fatalf("selection none: %d", len(n))
	}
	state := alice.Do("GET", "/api/v1/iptv/state?profile_id="+ap, nil).Expect(200).JSON()
	if state["available"] != false || state["playlists"].([]any)[0].(map[string]any)["selected"] != false {
		t.Fatalf("state %v", state)
	}
	s := alice.Do("PUT", "/api/v1/profiles/"+ap+"/settings", map[string]any{"iptv_playlists": "all"}).Expect(200).JSON()
	if s["iptv_playlists"] != "all" {
		t.Fatalf("settings %v", s)
	}

	// Watched channel → last channel.
	alice.Do("POST", "/api/v1/iptv/watched", map[string]any{"profile_id": ap, "channel_id": ntv["id"]}).Expect(204)
	bob.Do("POST", "/api/v1/iptv/watched", map[string]any{"profile_id": ap, "channel_id": ntv["id"]}).Expect(404)
	state = alice.Do("GET", "/api/v1/iptv/state?profile_id="+ap, nil).Expect(200).JSON()
	last, _ := state["last"].(map[string]any)
	if state["available"] != true || last == nil || last["channel"].(map[string]any)["name"] != "NTV" {
		t.Fatalf("last %v", state)
	}
}

func TestIPTVLivePlayback(t *testing.T) {
	env, f := newIPTVEnv(t)
	admin, _ := env.NewUserClient("iptvadmin", "admin")
	alice, _ := env.NewUserClient("alice", "user")
	admin.Do("POST", "/api/v1/admin/iptv/playlists", map[string]any{"kind": "iptv_org_country", "country": "ru"}).Expect(201)
	env.Server.IPTV.Wait()
	ap := alice.Do("POST", "/api/v1/profiles", map[string]string{"name": "Alice"}).Expect(201).JSON()["id"].(string)

	// A paired TV can list and play.
	_, cred := env.Pair(alice, "Living room")
	tv := env.Client()
	tv.Bearer = cred
	items := tv.Do("GET", "/api/v1/iptv/channels?profile_id="+ap, nil).Expect(200).Items()
	x2 := chanByName(t, items, "2x2")["id"].(string)

	tv.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "iptv"}).Expect(422)
	tv.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "iptv", "channel_id": "6f1c1f9e-1111-4111-8111-111111111111"}).Expect(404)
	src := tv.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "iptv", "channel_id": x2, "profile_id": ap}).Expect(201).JSON()
	if src["kind"] != "iptv" || src["live"] != true || src["format"] != "hls" || src["media_id"] != nil || src["status"] != "ready" ||
		src["channel_id"] != x2 || src["mime_type"] != "application/vnd.apple.mpegurl" {
		t.Fatalf("source %v", src)
	}
	stream := src["stream_url"].(string)
	if !regexp.MustCompile(`^/api/v1/live/[A-Za-z0-9_-]+/index\.m3u8$`).MatchString(stream) {
		t.Fatalf("stream url %s", stream)
	}

	anon := env.Client() // <video src> sends no credentials
	master := anon.Do("GET", stream, nil).Expect(200)
	if !strings.Contains(master.Header.Get("Cache-Control"), "no-cache") || master.Header.Get("Content-Type") != "application/vnd.apple.mpegurl" {
		t.Fatalf("master headers %v", master.Header)
	}
	if strings.Contains(string(master.Body), f.srv.URL) {
		t.Fatal("upstream URL leaked")
	}
	token := strings.Split(stream, "/")[4]
	variant := ""
	for _, l := range strings.Split(string(master.Body), "\n") {
		if strings.HasPrefix(l, "/api/v1/live/"+token+"/") {
			variant = l
		}
	}
	if variant == "" {
		t.Fatalf("master %s", master.Body)
	}
	segs := func() (string, []string) {
		r := anon.Do("GET", variant, nil).Expect(200)
		if !strings.Contains(r.Header.Get("Cache-Control"), "no-cache") {
			t.Fatalf("variant cache-control %q", r.Header.Get("Cache-Control"))
		}
		var seq string
		var out []string
		for _, l := range strings.Split(string(r.Body), "\n") {
			if strings.HasPrefix(l, "#EXT-X-MEDIA-SEQUENCE:") {
				seq = l
			}
			if strings.HasPrefix(l, "/api/v1/live/"+token+"/") {
				out = append(out, l)
			}
		}
		return seq, out
	}
	seq1, s1 := segs()
	seq2, s2 := segs()
	if seq1 == seq2 || len(s1) != 2 || len(s2) != 2 || s1[1] != s2[0] {
		t.Fatalf("sliding window not rewritten fresh: %s %v / %s %v", seq1, s1, seq2, s2)
	}
	seg := anon.Do("GET", s2[1], nil).Expect(200)
	if seg.Body[0] != 0x47 || seg.Header.Get("Content-Type") != "video/mp2t" {
		t.Fatalf("segment %q %v", seg.Header.Get("Content-Type"), seg.Body[:4])
	}
	// Refs are bound to the channel: tampering is refused.
	parts := strings.Split(s2[1], "/")
	ref := strings.Split(parts[len(parts)-1], ".")
	anon.Do("GET", "/api/v1/live/"+token+"/"+ref[0]+"."+ref[0][:22]+".ts", nil).Expect(403)
	anon.Do("GET", "/api/v1/live/garbage/index.m3u8", nil).Expect(403)

	// #EXTVLCOPT user agent reaches the upstream.
	ntv := chanByName(t, items, "NTV")["id"].(string)
	s := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "iptv", "channel_id": ntv}).Expect(201).JSON()
	body := anon.Do("GET", s["stream_url"].(string), nil).Expect(200).Body
	if f.uaSeen.Load() != "TestUA/1.0" || !strings.Contains(string(body), "#EXT-X-MEDIA-SEQUENCE:7") {
		t.Fatalf("ua %v body %s", f.uaSeen.Load(), body)
	}

	// Plain MPEG-TS: detected by probing, passed through.
	tsk := chanByName(t, items, "TS Kino")["id"].(string)
	s = alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "iptv", "channel_id": tsk}).Expect(201).JSON()
	if s["format"] != "ts" || !strings.HasSuffix(s["stream_url"].(string), "/stream.ts") || s["mime_type"] != "video/mp2t" {
		t.Fatalf("ts source %v", s)
	}
	tsb := anon.Do("GET", s["stream_url"].(string), nil).Expect(200)
	if len(tsb.Body) != 1880 || tsb.Body[0] != 0x47 {
		t.Fatalf("ts body %d", len(tsb.Body))
	}
	if c := chanByName(t, alice.Do("GET", "/api/v1/iptv/channels", nil).Expect(200).Items(), "TS Kino"); c["format"] != "ts" {
		t.Fatalf("format not remembered %v", c)
	}

	// Health: three failures mark a channel offline; it stays playable.
	dead := chanByName(t, items, "Dead")["id"].(string)
	s = alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "iptv", "channel_id": dead}).Expect(201).JSON()
	for i := 0; i < 3; i++ {
		anon.Do("GET", s["stream_url"].(string), nil).Expect(502)
	}
	if c := chanByName(t, alice.Do("GET", "/api/v1/iptv/channels", nil).Expect(200).Items(), "Dead"); c["offline"] != true {
		t.Fatalf("dead channel not offline %v", c)
	}
	anon.Do("GET", stream, nil).Expect(200) // a success elsewhere doesn't touch it
	if c := chanByName(t, alice.Do("GET", "/api/v1/iptv/channels", nil).Expect(200).Items(), "2x2"); c["offline"] != false {
		t.Fatalf("2x2 %v", c)
	}

	// A disabled playlist's channels can't be played any more.
	pls := admin.Do("GET", "/api/v1/admin/iptv/playlists", nil).Expect(200).Items()
	admin.Do("PATCH", "/api/v1/admin/iptv/playlists/"+pls[0]["id"].(string), map[string]any{"enabled": false}).Expect(200)
	anon.Do("GET", stream, nil).Expect(404)
	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "iptv", "channel_id": x2}).Expect(404)
}

func TestIPTVUploadedAndURLPlaylists(t *testing.T) {
	env, f := newIPTVEnv(t)
	admin, _ := env.NewUserClient("iptvadmin", "admin")

	file := admin.Do("POST", "/api/v1/admin/iptv/playlists", map[string]any{"kind": "m3u_file", "name": "Провайдер"}).Expect(201).JSON()
	id := file["id"].(string)
	admin.Do("POST", "/api/v1/admin/iptv/playlists/"+id+"/refresh", nil).Expect(422) // nothing uploaded yet
	upload := func(body string) *http.Response {
		req, _ := http.NewRequest("PUT", env.BaseURL+"/api/v1/admin/iptv/playlists/"+id+"/content", strings.NewReader(body))
		req.Header.Set("Content-Type", "text/plain")
		req.Header.Set("Origin", admin.Origin)
		req.Header.Set("X-CSRF-Token", admin.CSRF)
		req.AddCookie(&http.Cookie{Name: "mt_session", Value: admin.SessionCookie()})
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp
	}
	if r := upload("not a playlist"); r.StatusCode != 422 {
		t.Fatalf("bad upload %d", r.StatusCode)
	}
	// > 1 MiB (the default body limit) but < 5 MB: accepted.
	var b strings.Builder
	b.WriteString("#EXTM3U\n")
	for i := 0; b.Len() < 1500<<10; i++ {
		fmt.Fprintf(&b, "#EXTINF:-1 group-title=\"Кино\" tvg-logo=\"%s/logo.png\",Канал %d %s\n%s/live/2x2/master.m3u8?c=%d\n",
			f.srv.URL, i, strings.Repeat("x", 200), f.srv.URL, i)
	}
	if r := upload(b.String()); r.StatusCode != 200 {
		t.Fatalf("upload %d", r.StatusCode)
	}
	env.Server.IPTV.Wait()
	got := admin.Do("GET", "/api/v1/admin/iptv/playlists", nil).Expect(200).Items()[0]
	if got["refresh"].(map[string]any)["status"] != "ok" || got["refresh"].(map[string]any)["fetched_via"] != "upload" ||
		got["stats"].(map[string]any)["channels"].(float64) < 4000 || got["epg"].(map[string]any)["status"] != "none" || got["has_content"] != true {
		t.Fatalf("uploaded %v", got)
	}

	u := admin.Do("POST", "/api/v1/admin/iptv/playlists", map[string]any{"kind": "m3u_url", "url": f.srv.URL + "/mine.m3u?password=secret",
		"user_agent": "Provider/2"}).Expect(201).JSON()
	if strings.Contains(u["url"].(string), "secret") {
		t.Fatalf("credentials not redacted: %v", u["url"])
	}
	env.Server.IPTV.Wait()
	all := admin.Do("GET", "/api/v1/admin/iptv/playlists", nil).Expect(200).JSON()
	var mine map[string]any
	for _, it := range all["items"].([]any) {
		if it.(map[string]any)["id"] == u["id"] {
			mine = it.(map[string]any)
		}
	}
	// The playlist header's url-tvg becomes the guide; it 404s → epg error.
	if mine["effective_epg_url"] != f.srv.URL+"/none.xml" || mine["epg"].(map[string]any)["status"] != "error" || mine["stats"].(map[string]any)["channels"] != 1.0 {
		t.Fatalf("m3u_url %v", mine)
	}
	totals := all["totals"].(map[string]any)
	if totals["channels"].(float64) < 4001 {
		t.Fatalf("totals %v", totals)
	}

	admin.Do("DELETE", "/api/v1/admin/iptv/playlists/"+id, nil).Expect(204)
	admin.Do("DELETE", "/api/v1/admin/iptv/playlists/"+id, nil).Expect(404)
	var n int
	_ = env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM iptv_channels WHERE playlist_id = $1`, id).Scan(&n)
	if n != 0 {
		t.Fatalf("channels left %d", n)
	}
	countries := admin.Do("GET", "/api/v1/admin/iptv/countries", nil).Expect(200).Items()
	if countries[0]["code"] != "ru" || countries[0]["suggested"] != true {
		t.Fatalf("countries %v", countries[0])
	}
}

func TestIPTVPlayCommandPayload(t *testing.T) {
	ok := []string{`{"channel_id":"6f1c1f9e-1111-4111-8111-111111111111"}`,
		`{"channel_id":"6f1c1f9e-1111-4111-8111-111111111111","profile_id":"6f1c1f9e-2222-4111-8111-111111111111","force":true,"junk":1}`}
	for _, p := range ok {
		out, media, err := realtime.ValidatePayload("iptv.play", json.RawMessage(p))
		if err != nil || media != nil || strings.Contains(string(out), "junk") {
			t.Fatalf("%s → %s %v %v", p, out, media, err)
		}
	}
	for _, p := range []string{``, `{}`, `{"channel_id":"x"}`, `{"channel_id":"6f1c1f9e-1111-4111-8111-111111111111","profile_id":"no"}`} {
		if _, _, err := realtime.ValidatePayload("iptv.play", json.RawMessage(p)); err == nil {
			t.Fatalf("%s accepted", p)
		}
	}
}

func TestIPTVMultipleGuidesAndLogoFailures(t *testing.T) {
	env, f := newIPTVEnv(t)
	admin, _ := env.NewUserClient("iptvadmin", "admin")
	base := f.srv.URL
	pl := admin.Do("POST", "/api/v1/admin/iptv/playlists", map[string]any{"kind": "m3u_url", "url": base + "/mine2.m3u",
		"epg_url": base + "/gA.xml\n" + base + "/gone.xml, " + base + "/gB.xml.gz"}).Expect(201).JSON()
	id := pl["id"].(string)
	admin.Do("PATCH", "/api/v1/admin/iptv/playlists/"+id, map[string]any{"epg_url": "ftp://x"}).Expect(422)
	env.Server.IPTV.Wait()

	got := admin.Do("GET", "/api/v1/admin/iptv/playlists", nil).Expect(200).Items()[0]
	epg := got["epg"].(map[string]any)
	guides := epg["guides"].([]any)
	if epg["status"] != "ok" || !strings.Contains(epg["error"].(string), "1 of 3 guides failed") || len(guides) != 3 ||
		len(got["epg_urls"].([]any)) != 3 {
		t.Fatalf("epg %v", epg)
	}
	g0, g1, g2 := guides[0].(map[string]any), guides[1].(map[string]any), guides[2].(map[string]any)
	if g0["status"] != "ok" || g0["matched"] != 1.0 || g0["fetched_via"] != "direct" || g0["bytes"].(float64) < 100 ||
		g1["status"] != "error" || !strings.Contains(g1["error"].(string), "HTTP 404") || g2["matched"] != 2.0 {
		t.Fatalf("guides %v / %v / %v", g0, g1, g2)
	}
	if st := got["stats"].(map[string]any); st["epg_matched"] != 2.0 || st["with_programmes"] != 2.0 {
		t.Fatalf("stats %v", st)
	}
	now := func(name string) string {
		c := chanByName(t, admin.Do("GET", "/api/v1/iptv/channels", nil).Expect(200).Items(), name)
		if n, _ := c["now"].(map[string]any); n != nil {
			return n["title"].(string)
		}
		return ""
	}
	// First guide wins; the second fills what the first lacks.
	if now("2x2") != "From A" || now("NTV") != "B news" {
		t.Fatalf("merge: 2x2 %q NTV %q", now("2x2"), now("NTV"))
	}
	admin.Do("PATCH", "/api/v1/admin/iptv/playlists/"+id, map[string]any{"epg_url": base + "/gB.xml.gz " + base + "/gA.xml"}).Expect(200)
	env.Server.IPTV.Wait()
	if now("2x2") != "From B" {
		t.Fatalf("reordered: %q", now("2x2"))
	}
	if e := admin.Do("GET", "/api/v1/admin/iptv/playlists", nil).Expect(200).Items()[0]["epg"].(map[string]any); e["error"] != nil || e["status"] != "ok" {
		t.Fatalf("after reorder %v", e)
	}

	// A failing logo: 502 once, then lists drop logo_url and the proxy
	// answers 404 without asking upstream again.
	bad := chanByName(t, admin.Do("GET", "/api/v1/iptv/channels", nil).Expect(200).Items(), "Bad logo")
	env.Client().Do("GET", bad["logo_url"].(string), nil).Expect(502)
	env.Client().Do("GET", bad["logo_url"].(string), nil).Expect(404)
	if f.badLogo.Load() != 1 {
		t.Fatalf("upstream logo hits %d", f.badLogo.Load())
	}
	if c := chanByName(t, admin.Do("GET", "/api/v1/iptv/channels", nil).Expect(200).Items(), "Bad logo"); c["logo_url"] != nil {
		t.Fatalf("logo_url %v", c["logo_url"])
	}
}
