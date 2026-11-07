package server_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/livecheck"
	"martytv/api/internal/testutil"
)

// TestIPTVRealStreams is the manual stream checker: it imports the public
// iptv-org country playlists, then for every channel (a) walks the upstream
// directly (iptv.CheckChannel: dead / geo / timeout / codec …) and (b) plays
// it the way hls.js does through Cineko's own pipeline (POST
// /playback/sources → /api/v1/live/… master → variant → a segment near the
// live edge). Read-only GETs against the internet:
//
//	IPTV_STREAM_CHECK=ru,kz,ua,by,int TEST_DATABASE_URL=… go test -run TestIPTVRealStreams -v -timeout 60m ./internal/server/
//
// IPTV_STREAM_CHECK_LIMIT caps channels per playlist; IPTV_STREAM_CHECK_PROXY
// (socks5h://…) sets IPTV_PROXY_URL for the pipeline's fallback.
func TestIPTVRealStreams(t *testing.T) {
	countries := os.Getenv("IPTV_STREAM_CHECK")
	if countries == "" {
		t.Skip("set IPTV_STREAM_CHECK=ru,kz,…")
	}
	limit := 0
	_, _ = fmt.Sscan(os.Getenv("IPTV_STREAM_CHECK_LIMIT"), &limit)
	env := testutil.New(t, func(c *config.Config) {
		c.IPTV.OrgEPGOff = true // no guides: streams only
		c.IPTV.ProxyURL = nil
		if p := os.Getenv("IPTV_STREAM_CHECK_PROXY"); p != "" {
			c.IPTV.ProxyURL, _ = url.Parse(p)
		}
		c.Catalog.ImageCacheDir = t.TempDir()
	})
	t.Cleanup(env.Server.IPTV.Wait)
	admin, _ := env.NewUserClient("checker", "admin")
	codes := strings.Split(countries, ",")
	for _, cc := range codes {
		admin.Do("POST", "/api/v1/admin/iptv/playlists", map[string]any{"kind": "iptv_org_country", "country": cc}).Expect(201)
	}
	env.Server.IPTV.Wait()

	type row struct{ id, country, name, url, ua, ref string }
	rows, err := env.Pool.Query(context.Background(), `SELECT c.id, p.country, c.name, c.stream_url, COALESCE(c.user_agent, ''), COALESCE(c.referrer, '')
		FROM iptv_channels c JOIN iptv_playlists p ON p.id = c.playlist_id ORDER BY p.country, c.position`)
	if err != nil {
		t.Fatal(err)
	}
	var chans []row
	per := map[string]int{}
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.country, &r.name, &r.url, &r.ua, &r.ref); err != nil {
			t.Fatal(err)
		}
		if limit > 0 && per[r.country] >= limit {
			continue
		}
		per[r.country]++
		chans = append(chans, r)
	}
	rows.Close()

	cookie := admin.SessionCookie()
	hc := &http.Client{Timeout: 30 * time.Second}
	type result struct {
		row
		direct   livecheck.Result
		pipeline string // ok | <stage>_<status>
		http     bool   // plain-http entry (mixed content if the browser fetched it)
		cors     bool   // the entry answers with Access-Control-Allow-Origin
	}
	results := make([]result, len(chans))
	sem := make(chan struct{}, 24)
	var wg sync.WaitGroup
	for i, ch := range chans {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, ch row) {
			defer func() { <-sem; wg.Done() }()
			ctx := context.Background()
			r := result{row: ch, http: strings.HasPrefix(ch.url, "http://")}
			r.direct, _ = env.Server.IPTV.CheckChannel(ctx, ch.id)
			r.cors = corsAllowed(ch.url, ch.ua, ch.ref)
			r.pipeline = playThroughPipeline(env.BaseURL, cookie, admin.CSRF, ch.id, hc)
			results[i] = r
		}(i, ch)
	}
	wg.Wait()

	for _, cc := range codes {
		var n, pOK, browser int
		health, causes, pipe := map[string]int{}, map[string]int{}, map[string]int{}
		var plain, noCORS, withHeaders int
		var mismatch []string
		for _, r := range results {
			if r.country != cc {
				continue
			}
			n++
			health[r.direct.Health]++
			causes[r.direct.Cause]++
			pipe[r.pipeline]++
			if r.pipeline == "ok" || r.pipeline == "ok_ts" {
				pOK++
			}
			// Plays in a desktop browser (hls.js): HLS through the pipeline, no codec issue.
			if r.pipeline == "ok" && r.direct.Health == livecheck.HealthOK {
				browser++
			}
			if r.http {
				plain++
			}
			if !r.cors {
				noCORS++
			}
			if r.ua != "" || r.ref != "" {
				withHeaders++
			}
			if (r.direct.Health == livecheck.HealthOK || r.direct.Health == livecheck.HealthCodec) && r.pipeline != "ok" && r.pipeline != "ok_ts" {
				mismatch = append(mismatch, fmt.Sprintf("%s [%s/%s %s%s] → %s", r.name, r.direct.Format, r.direct.Cause, r.direct.Video, "/"+r.direct.Audio, r.pipeline))
			}
		}
		t.Logf("== %s: %d channels; pipeline ok %d (%.0f%%), browser-playable HLS %d (%.0f%%); plain http %d, no CORS %d, with UA/Referer %d",
			cc, n, pOK, pct(pOK, n), browser, pct(browser, n), plain, noCORS, withHeaders)
		t.Logf("   direct health: %s", fmtCounts(health))
		t.Logf("   direct causes: %s", fmtCounts(causes))
		t.Logf("   pipeline:      %s", fmtCounts(pipe))
		for _, m := range mismatch {
			t.Logf("   ✗ direct ok, pipeline failed: %s", m)
		}
	}
	if os.Getenv("IPTV_STREAM_CHECK_VERBOSE") != "" {
		for _, r := range results {
			t.Logf("%s | %s | %s/%s %s %s | %s", r.country, r.name, r.direct.Health, r.direct.Cause, r.direct.Video, r.direct.Audio, r.pipeline)
		}
	}
}

func pct(a, b int) float64 {
	if b == 0 {
		return 0
	}
	return 100 * float64(a) / float64(b)
}

func fmtCounts(m map[string]int) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return m[keys[i]] > m[keys[j]] || m[keys[i]] == m[keys[j]] && keys[i] < keys[j] })
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, "%s %d, ", k, m[k])
	}
	return strings.TrimSuffix(b.String(), ", ")
}

// corsAllowed: would a browser on another origin be allowed to read the entry URL?
func corsAllowed(u, ua, ref string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Origin", "https://cineko.example")
	if ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	if ref != "" {
		req.Header.Set("Referer", ref)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	a := resp.Header.Get("Access-Control-Allow-Origin")
	return a == "*" || a == "https://cineko.example"
}

// playThroughPipeline plays a channel like hls.js: create the source, load
// the master, the first variant, a segment near the live edge.
func playThroughPipeline(base, cookie, csrf, id string, hc *http.Client) string {
	body, _ := json.Marshal(map[string]any{"kind": "iptv", "channel_id": id})
	req, _ := http.NewRequest("POST", base+"/api/v1/playback/sources", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", base)
	req.Header.Set("X-CSRF-Token", csrf)
	req.Header.Set("Cookie", "mt_session="+cookie)
	resp, err := hc.Do(req)
	if err != nil {
		return "source_neterr"
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 201 {
		var e struct {
			Error struct{ Code string } `json:"error"`
		}
		_ = json.Unmarshal(b, &e)
		return fmt.Sprintf("source_%d_%s", resp.StatusCode, e.Error.Code)
	}
	var src struct {
		StreamURL string `json:"stream_url"`
		Format    string `json:"format"`
	}
	_ = json.Unmarshal(b, &src)
	get := func(u string, limit int64) ([]byte, string, int) {
		if !strings.HasPrefix(u, "http") {
			u = base + u
		}
		resp, err := hc.Get(u)
		if err != nil {
			return nil, "", -1
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, limit))
		return b, resp.Header.Get("Content-Type"), resp.StatusCode
	}
	if src.Format == "ts" {
		b, _, st := get(src.StreamURL, 64<<10)
		if st != 200 || len(b) == 0 || !bytes.Contains(b[:min(len(b), 1024)], []byte{0x47}) {
			return fmt.Sprintf("ts_%d", st)
		}
		return "ok_ts"
	}
	b, _, st := get(src.StreamURL, 2<<20)
	if st != 200 {
		return fmt.Sprintf("master_%d", st)
	}
	uris := playlistURIs(b)
	if bytes.Contains(b, []byte("#EXT-X-STREAM-INF")) {
		if len(uris) == 0 {
			return "master_empty"
		}
		var ct string
		b, ct, st = get(uris[0], 2<<20)
		if st != 200 {
			return fmt.Sprintf("variant_%d", st)
		}
		if !bytes.HasPrefix(bytes.TrimSpace(b), []byte("#EXTM3U")) {
			return "variant_not_playlist(" + ct + ")"
		}
		uris = playlistURIs(b)
	}
	if len(uris) == 0 {
		return "media_empty"
	}
	seg := uris[max(0, len(uris)-3)]
	sb, _, st := get(seg, 64<<10)
	if (st != 200 && st != 206) || len(sb) == 0 {
		return fmt.Sprintf("segment_%d", st)
	}
	return "ok"
}

func playlistURIs(b []byte) []string {
	var out []string
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 64<<10), 2<<20)
	for sc.Scan() {
		l := strings.TrimSpace(sc.Text())
		if l != "" && !strings.HasPrefix(l, "#") {
			out = append(out, l)
		}
	}
	return out
}
