package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Torrent fallback: when YouTube can't play a track (no upload found, the
// upload is blocked, Invidious/VPN down), the track is looked up on the
// trackers instead — its album (or the artist's discography) is opened in
// TorrServer and the matching file is streamed. Found files are remembered
// per track, so the next play starts right away.

const torrentMatchSchema = `
CREATE TABLE IF NOT EXISTS torrent_match (
  track_id TEXT PRIMARY KEY, hash TEXT NOT NULL, file INTEGER NOT NULL,
  start_ms INTEGER NOT NULL DEFAULT 0, end_ms INTEGER NOT NULL DEFAULT 0,
  ext TEXT NOT NULL, updated_at INTEGER NOT NULL);`

func (s *Store) TorrentMatch(ctx context.Context, trackID string) (*TorrentSrc, bool) {
	var src TorrentSrc
	err := s.db.QueryRowContext(ctx, `SELECT hash,file,start_ms,end_ms,ext FROM torrent_match WHERE track_id=?`, trackID).
		Scan(&src.Hash, &src.File, &src.Start, &src.End, &src.Ext)
	if err != nil {
		return nil, false
	}
	return &src, true
}

func (s *Store) SetTorrentMatch(ctx context.Context, trackID string, src *TorrentSrc) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO torrent_match(track_id,hash,file,start_ms,end_ms,ext,updated_at) VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(track_id) DO UPDATE SET hash=excluded.hash,file=excluded.file,start_ms=excluded.start_ms,
		end_ms=excluded.end_ms,ext=excluded.ext,updated_at=excluded.updated_at`,
		trackID, src.Hash, src.File, src.Start, src.End, src.Ext, now())
	return err
}

func (s *Store) ForgetTorrentMatch(ctx context.Context, trackID string) {
	_, _ = s.db.ExecContext(ctx, `DELETE FROM torrent_match WHERE track_id=?`, trackID)
}

func migrateFallback(db *sql.DB) error {
	if _, err := db.Exec(torrentMatchSchema); err != nil {
		return err
	}
	// manual = chosen by a listener ("always play from this torrent"): wins over YouTube.
	_, _ = db.Exec(`ALTER TABLE torrent_match ADD COLUMN manual INTEGER NOT NULL DEFAULT 0`)
	return nil
}

// ManualTorrent returns a listener-chosen torrent file for the track.
func (s *Store) ManualTorrent(ctx context.Context, trackID string) (*TorrentSrc, bool) {
	var src TorrentSrc
	err := s.db.QueryRowContext(ctx, `SELECT hash,file,start_ms,end_ms,ext FROM torrent_match WHERE track_id=? AND manual=1`, trackID).
		Scan(&src.Hash, &src.File, &src.Start, &src.End, &src.Ext)
	if err != nil {
		return nil, false
	}
	return &src, true
}

func (s *Store) SetManualTorrent(ctx context.Context, trackID string, src *TorrentSrc) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO torrent_match(track_id,hash,file,start_ms,end_ms,ext,updated_at,manual) VALUES(?,?,?,?,?,?,?,1)
		ON CONFLICT(track_id) DO UPDATE SET hash=excluded.hash,file=excluded.file,start_ms=excluded.start_ms,
		end_ms=excluded.end_ms,ext=excluded.ext,updated_at=excluded.updated_at,manual=1`,
		trackID, src.Hash, src.File, src.Start, src.End, src.Ext, now())
	return err
}

// serveManual redirects to the chosen torrent file, if the track has one.
func (a *App) serveManual(w http.ResponseWriter, r *http.Request, trackID string) bool {
	src, ok := a.st.ManualTorrent(r.Context(), trackID)
	if !ok || memo.isBad(trackID, torrentValue(src)) {
		return false
	}
	if row, err := a.st.Torrent(r.Context(), src.Hash); err != nil {
		return false
	} else if _, err := a.tor.ensure(r.Context(), row); err != nil {
		return false
	}
	memo.setServed(trackID, torrentValue(src))
	redirectTorrent(w, r, src)
	return true
}

// hTorrentChoice: PUT {trackId, src} sets / DELETE ?trackId= clears the
// track's "always from this torrent" file (shared by the household, like
// the YouTube recording choice).
func (a *App) hTorrentChoice(w http.ResponseWriter, r *http.Request, u *User) error {
	if r.Method == http.MethodDelete {
		id := r.URL.Query().Get("trackId")
		if !validTrackID(id) {
			return errStatus(400, "bad_request", "Некорректный трек")
		}
		a.st.ForgetTorrentMatch(r.Context(), id)
		w.WriteHeader(204)
		return nil
	}
	var b struct {
		TrackID string     `json:"trackId"`
		Src     TorrentSrc `json:"src"`
	}
	if err := readJSON(r, &b); err != nil {
		return err
	}
	if !validTrackID(b.TrackID) || !validHash(b.Src.Hash) || b.Src.File < 0 {
		return errStatus(400, "bad_request", "Некорректный трек")
	}
	if _, err := a.st.Torrent(r.Context(), b.Src.Hash); err != nil {
		return errStatus(404, "not_found", "Раздача не открыта")
	}
	if err := a.st.SetManualTorrent(r.Context(), b.TrackID, &b.Src); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

var errNoTorrent = errors.New("track not found on the trackers either")

// torrentFallback finds a torrent file for the track (cached per track id;
// concurrent calls share one search).
func (a *App) torrentFallback(ctx context.Context, t *Track) (*TorrentSrc, error) {
	if !a.tor.SearchConfigured() {
		return nil, errNoTorrent
	}
	if src, ok := a.st.TorrentMatch(ctx, t.ID); ok && !memo.isBad(t.ID, torrentValue(src)) {
		if row, err := a.st.Torrent(ctx, src.Hash); err == nil {
			if _, err := a.tor.ensure(ctx, row); err == nil {
				return src, nil
			}
		}
		a.st.ForgetTorrentMatch(ctx, t.ID)
	}
	key := "tf:" + t.ID
	a.resolveMu.Lock()
	if c, ok := a.resolving[key]; ok {
		a.resolveMu.Unlock()
		select {
		case <-c.done:
			if c.err != nil {
				return nil, c.err
			}
			src, ok := a.st.TorrentMatch(ctx, t.ID)
			if !ok {
				return nil, errNoTorrent
			}
			return src, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	c := &resolveCall{done: make(chan struct{})}
	a.resolving[key] = c
	a.resolveMu.Unlock()

	fctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	src, err := a.findInTorrents(fctx, t)
	cancel()
	if err == nil {
		_ = a.st.SetTorrentMatch(context.Background(), t.ID, src)
	}
	c.err = err
	close(c.done)
	a.resolveMu.Lock()
	delete(a.resolving, key)
	a.resolveMu.Unlock()
	return src, err
}

func (a *App) findInTorrents(ctx context.Context, t *Track) (*TorrentSrc, error) {
	artist := strings.TrimSpace(strings.Split(t.Artist, ",")[0])
	if artist == "" {
		return nil, errNoTorrent
	}
	var queries []string
	album := ""
	if t.Album != "" {
		album = t.Album
		queries = []string{artist + " " + t.Album, artist + " дискография"}
	} else {
		queries = []string{artist + " " + cleanTitle(t.Title), artist + " дискография"}
	}
	rels, err := a.tor.Search(ctx, queries, artist, album)
	if err != nil {
		return nil, err
	}
	tried := 0
	for _, r := range rels {
		if tried >= 3 || ctx.Err() != nil {
			break
		}
		if r.Seeders == 0 {
			continue
		}
		tried++
		hash, err := a.tor.Open(ctx, a.st, r.ID)
		if err != nil {
			a.log.Info("fallback: open failed", "release", r.Title, "err", err.Error())
			continue
		}
		info, err := a.tor.Info(ctx, a.st, hash, 20*time.Second)
		if err != nil || !info.Ready {
			continue
		}
		if tr := pickTorrentTrack(t, info.Tracks); tr != nil && !memo.isBad(t.ID, torrentValue(tr.Src)) {
			a.log.Info("fallback: torrent match", "track", t.ID, "release", r.Title, "file", tr.Title)
			return tr.Src, nil
		}
	}
	return nil, errNoTorrent
}

// pickTorrentTrack: the release file with the same title, preferring the
// album's folder and the same track number.
func pickTorrentTrack(t *Track, tracks []TorrentTrack) *TorrentTrack {
	want := normalize(cleanTitle(t.Title))
	nAlbum := normalize(t.Album)
	var best *TorrentTrack
	bestScore := 0
	for i := range tracks {
		tr := &tracks[i]
		got := normalize(cleanTitle(tr.Title))
		score := 0
		switch {
		case got == want:
			score = 100
		case len(want) > 3 && strings.Contains(got, want):
			score = 70
		case len(got) > 3 && strings.Contains(want, got):
			score = 50
		default:
			continue
		}
		if nAlbum != "" && (strings.Contains(normalize(tr.Dir), nAlbum) || strings.Contains(normalize(tr.Album), nAlbum)) {
			score += 20
		}
		if t.Position > 0 && tr.Number == t.Position {
			score += 10
		}
		if tr.Src != nil && tr.Src.Lossless {
			score += 2
		}
		if score > bestScore {
			best, bestScore = tr, score
		}
	}
	return best
}

// redirectTorrent sends the player to the torrent stream of src.
func redirectTorrent(w http.ResponseWriter, r *http.Request, src *TorrentSrc) {
	u := "/music/api/stream/" + src.Hash + "/" + strconv.Itoa(src.File)
	native := nativeExts[src.Ext] && src.Start == 0 && src.End == 0
	q := url.Values{}
	if native {
		q.Set("ext", src.Ext)
	} else {
		q.Set("tc", "1")
		if src.Start > 0 {
			q.Set("start", strconv.FormatInt(src.Start, 10))
		}
		if src.End > 0 {
			q.Set("end", strconv.FormatInt(src.End, 10))
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, u+"?"+q.Encode(), http.StatusFound)
}

// playFallback is called when YouTube failed for t: redirect to a torrent
// file, or report the original error.
func (a *App) playFallback(w http.ResponseWriter, r *http.Request, t *Track, ytErr error) error {
	// Zaycev first (quick, 320 kbps MP3), then the trackers.
	if id, ok := a.zaycevFallback(r.Context(), t); ok {
		memo.setServed(t.ID, "zv:"+strconv.FormatInt(id, 10))
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, "/music/api/zv/"+strconv.FormatInt(id, 10), http.StatusFound)
		return nil
	}
	src, err := a.torrentFallback(r.Context(), t)
	if err != nil {
		a.log.Info("no playable source", "track", t.ID, "youtube", errString(ytErr), "torrent", err.Error())
		if ytErr != nil {
			return ytErr
		}
		return err
	}
	memo.setServed(t.ID, torrentValue(src))
	redirectTorrent(w, r, src)
	return nil
}
