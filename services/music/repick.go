package main

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Re-picking a track's source when it can't be played. The server remembers
// what it last served for a track (YouTube video, "zv:<n>", "t:<hash>:<file>");
// the player, when that fails, asks again with ?repick=1: that source is
// marked bad for a while (auto choices are forgotten, manual ones skipped) and
// the next best one is picked — YouTube, zaycev, then the trackers.

const badTTL = 6 * time.Hour

type sourceMemo struct {
	mu     sync.Mutex
	bad    map[string]map[string]time.Time
	served map[string]string
}

var memo = &sourceMemo{bad: map[string]map[string]time.Time{}, served: map[string]string{}}

func (m *sourceMemo) markBad(key, v string) {
	if key == "" || v == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.bad) > 5000 {
		m.bad = map[string]map[string]time.Time{}
	}
	s := m.bad[key]
	if s == nil {
		s = map[string]time.Time{}
		m.bad[key] = s
	}
	s[v] = time.Now()
}

func (m *sourceMemo) isBad(key, v string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	at, ok := m.bad[key][v]
	return ok && time.Since(at) < badTTL
}

// clearBad: the listener chose v by hand (it may have failed here before).
func (m *sourceMemo) clearBad(key, v string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.bad[key], v)
}

func (m *sourceMemo) setServed(key, v string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.served) > 5000 {
		m.served = map[string]string{}
	}
	m.served[key] = v
}

func (m *sourceMemo) lastServed(key string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.served[key]
}

func torrentValue(src *TorrentSrc) string {
	return "t:" + src.Hash + ":" + strconv.Itoa(src.File)
}

func wantsRepick(r *http.Request) bool { return r.URL.Query().Get("repick") == "1" }

// repick drops what was last served for key: marked bad, and forgotten if it
// was chosen automatically.
func (a *App) repick(ctx context.Context, key string) {
	v := memo.lastServed(key)
	if v == "" {
		return
	}
	memo.markBad(key, v)
	a.log.Info("repick", "track", key, "failed", v)
	if strings.HasPrefix(v, "t:") {
		if src, ok := a.st.TorrentMatch(ctx, key); ok && torrentValue(src) == v {
			a.st.ForgetTorrentMatch(ctx, key)
		}
		return
	}
	_ = a.st.ForgetAutoMatch(ctx, key, v)
	if zid, ok := zvMatch(v); ok {
		_ = a.st.ForgetAutoMatch(ctx, "zv|"+key, strconv.FormatInt(zid, 10))
	}
}

// zvPick: the best zaycev upload of t that isn't marked bad and gives a
// play link right now.
func (a *App) zvPick(ctx context.Context, t *Track) (int64, bool) {
	zctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	ranked, err := a.zv.Ranked(zctx, t)
	if err != nil {
		return 0, false
	}
	tried := 0
	for _, c := range ranked {
		if c.Score < 70 || tried >= 2 {
			break
		}
		if memo.isBad(t.ID, c.ID) {
			continue
		}
		tried++
		id, ok := zvMatch(c.ID)
		if !ok {
			continue
		}
		if _, err := a.zv.PlayURL(zctx, id, false); err == nil {
			return id, true
		}
		memo.markBad(t.ID, c.ID)
	}
	return 0, false
}
