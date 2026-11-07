package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	_ "modernc.org/sqlite"
)

// Store is the service's own SQLite database: each account's library plus
// the shared caches (YouTube matches, opened torrents).
type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS likes (
  user_id TEXT NOT NULL, track_id TEXT NOT NULL, data TEXT NOT NULL, added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id));
CREATE TABLE IF NOT EXISTS saved (
  user_id TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, data TEXT NOT NULL, added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, item_id));
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS playlists_user ON playlists(user_id);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL, track_id TEXT NOT NULL, data TEXT NOT NULL, added_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS playlist_tracks_pl ON playlist_tracks(playlist_id, pos);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, track_id TEXT NOT NULL,
  data TEXT NOT NULL, played_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS history_user ON history(user_id, played_at);
CREATE TABLE IF NOT EXISTS yt_match (
  track_id TEXT PRIMARY KEY, video_id TEXT NOT NULL, manual INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS torrents (
  hash TEXT PRIMARY KEY, title TEXT NOT NULL, magnet TEXT NOT NULL DEFAULT '', torrent BLOB,
  files TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL, used_at INTEGER NOT NULL);
`

func openStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	// One connection: SQLite serializes writers anyway, and this keeps the
	// pragmas (foreign_keys) on every statement.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateAI(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateFallback(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateSoundtrack(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func now() int64 { return time.Now().Unix() }

// ---- likes ----

func (s *Store) Likes(ctx context.Context, user string) ([]json.RawMessage, error) {
	return s.rawList(ctx, `SELECT data FROM likes WHERE user_id=? ORDER BY added_at DESC`, user)
}

func (s *Store) LikedIDs(ctx context.Context, user string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT track_id FROM likes WHERE user_id=?`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) Like(ctx context.Context, user, id string, data []byte) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO likes(user_id,track_id,data,added_at) VALUES(?,?,?,?)
		ON CONFLICT(user_id,track_id) DO UPDATE SET data=excluded.data`, user, id, string(data), now())
	return err
}

func (s *Store) Unlike(ctx context.Context, user, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM likes WHERE user_id=? AND track_id=?`, user, id)
	return err
}

// ---- saved albums / artists / playlists ----

type SavedItem struct {
	Kind    string          `json:"kind"`
	ID      string          `json:"id"`
	Data    json.RawMessage `json:"data"`
	AddedAt int64           `json:"addedAt"`
}

func (s *Store) Saved(ctx context.Context, user string) ([]SavedItem, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT kind,item_id,data,added_at FROM saved WHERE user_id=? ORDER BY added_at DESC`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SavedItem{}
	for rows.Next() {
		var it SavedItem
		var data string
		if err := rows.Scan(&it.Kind, &it.ID, &data, &it.AddedAt); err != nil {
			return nil, err
		}
		it.Data = json.RawMessage(data)
		out = append(out, it)
	}
	return out, rows.Err()
}

func (s *Store) Save(ctx context.Context, user, kind, id string, data []byte) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO saved(user_id,kind,item_id,data,added_at) VALUES(?,?,?,?,?)
		ON CONFLICT(user_id,kind,item_id) DO UPDATE SET data=excluded.data`, user, kind, id, string(data), now())
	return err
}

func (s *Store) Unsave(ctx context.Context, user, kind, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM saved WHERE user_id=? AND kind=? AND item_id=?`, user, kind, id)
	return err
}

// ---- playlists ----

type Playlist struct {
	ID          int64    `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Count       int      `json:"count"`
	Covers      []string `json:"covers"`
	CreatedAt   int64    `json:"createdAt"`
	UpdatedAt   int64    `json:"updatedAt"`
}

type PlaylistEntry struct {
	EntryID int64           `json:"entryId"`
	Track   json.RawMessage `json:"track"`
	AddedAt int64           `json:"addedAt"`
}

var errNotFound = errors.New("not found")

func (s *Store) Playlists(ctx context.Context, user string) ([]Playlist, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT p.id,p.name,p.description,p.created_at,p.updated_at,
		(SELECT count(*) FROM playlist_tracks t WHERE t.playlist_id=p.id)
		FROM playlists p WHERE p.user_id=? ORDER BY p.updated_at DESC`, user)
	if err != nil {
		return nil, err
	}
	out := []Playlist{}
	for rows.Next() {
		var p Playlist
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.CreatedAt, &p.UpdatedAt, &p.Count); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Covers, _ = s.playlistCovers(ctx, out[i].ID)
	}
	return out, nil
}

// playlistCovers: up to four distinct album covers (the mosaic).
func (s *Store) playlistCovers(ctx context.Context, id int64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT data FROM playlist_tracks WHERE playlist_id=? ORDER BY pos LIMIT 40`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]bool{}
	out := []string{}
	for rows.Next() && len(out) < 4 {
		var data string
		if rows.Scan(&data) != nil {
			continue
		}
		var t struct {
			Cover string `json:"cover"`
		}
		if json.Unmarshal([]byte(data), &t) == nil && t.Cover != "" && !seen[t.Cover] {
			seen[t.Cover] = true
			out = append(out, t.Cover)
		}
	}
	return out, nil
}

func (s *Store) Playlist(ctx context.Context, user string, id int64) (*Playlist, []PlaylistEntry, error) {
	var p Playlist
	err := s.db.QueryRowContext(ctx, `SELECT id,name,description,created_at,updated_at FROM playlists WHERE id=? AND user_id=?`, id, user).
		Scan(&p.ID, &p.Name, &p.Description, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, errNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,data,added_at FROM playlist_tracks WHERE playlist_id=? ORDER BY pos, id`, id)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	entries := []PlaylistEntry{}
	for rows.Next() {
		var e PlaylistEntry
		var data string
		if err := rows.Scan(&e.EntryID, &data, &e.AddedAt); err != nil {
			return nil, nil, err
		}
		e.Track = json.RawMessage(data)
		entries = append(entries, e)
	}
	p.Count = len(entries)
	return &p, entries, rows.Err()
}

func (s *Store) CreatePlaylist(ctx context.Context, user, name, desc string) (int64, error) {
	t := now()
	res, err := s.db.ExecContext(ctx, `INSERT INTO playlists(user_id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)`, user, name, desc, t, t)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) owns(ctx context.Context, user string, id int64) error {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM playlists WHERE id=? AND user_id=?`, id, user).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return errNotFound
	}
	return err
}

func (s *Store) UpdatePlaylist(ctx context.Context, user string, id int64, name, desc string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE playlists SET name=?, description=?, updated_at=? WHERE id=? AND user_id=?`, name, desc, now(), id, user)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errNotFound
	}
	return nil
}

func (s *Store) DeletePlaylist(ctx context.Context, user string, id int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM playlists WHERE id=? AND user_id=?`, id, user)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errNotFound
	}
	return nil
}

type trackRow struct {
	ID   string
	Data []byte
}

func (s *Store) AddToPlaylist(ctx context.Context, user string, id int64, tracks []trackRow) error {
	if err := s.owns(ctx, user, id); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var maxPos sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT max(pos) FROM playlist_tracks WHERE playlist_id=?`, id).Scan(&maxPos); err != nil {
		return err
	}
	pos := maxPos.Int64
	t := now()
	for _, tr := range tracks {
		pos++
		if _, err := tx.ExecContext(ctx, `INSERT INTO playlist_tracks(playlist_id,pos,track_id,data,added_at) VALUES(?,?,?,?,?)`, id, pos, tr.ID, string(tr.Data), t); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE playlists SET updated_at=? WHERE id=?`, t, id); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) RemoveFromPlaylist(ctx context.Context, user string, id, entry int64) error {
	if err := s.owns(ctx, user, id); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM playlist_tracks WHERE id=? AND playlist_id=?`, entry, id); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE playlists SET updated_at=? WHERE id=?`, now(), id)
	return err
}

// ReorderPlaylist sets the order to the given entry ids (others keep theirs, after).
func (s *Store) ReorderPlaylist(ctx context.Context, user string, id int64, entries []int64) error {
	if err := s.owns(ctx, user, id); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE playlist_tracks SET pos=pos+1000000 WHERE playlist_id=?`, id); err != nil {
		return err
	}
	for i, e := range entries {
		if _, err := tx.ExecContext(ctx, `UPDATE playlist_tracks SET pos=? WHERE id=? AND playlist_id=?`, i+1, e, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ---- history ----

func (s *Store) AddHistory(ctx context.Context, user, id string, data []byte) error {
	// The same track twice in a row (repeat, seek restarts) counts once.
	var last string
	_ = s.db.QueryRowContext(ctx, `SELECT track_id FROM history WHERE user_id=? ORDER BY id DESC LIMIT 1`, user).Scan(&last)
	if last == id {
		_, err := s.db.ExecContext(ctx, `UPDATE history SET played_at=? WHERE id=(SELECT max(id) FROM history WHERE user_id=?)`, now(), user)
		return err
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO history(user_id,track_id,data,played_at) VALUES(?,?,?,?)`, user, id, string(data), now()); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM history WHERE user_id=? AND id NOT IN (SELECT id FROM history WHERE user_id=? ORDER BY id DESC LIMIT 1000)`, user, user)
	return err
}

// History returns the most recent plays, one entry per track.
func (s *Store) History(ctx context.Context, user string, limit int) ([]json.RawMessage, error) {
	return s.rawList(ctx, `SELECT data FROM history h WHERE user_id=? AND id=(SELECT max(id) FROM history WHERE user_id=h.user_id AND track_id=h.track_id)
		ORDER BY id DESC LIMIT ?`, user, limit)
}

// HistoryRaw returns the last plays including repeats (for taste: top artists).
func (s *Store) HistoryRaw(ctx context.Context, user string, limit int) ([]json.RawMessage, error) {
	return s.rawList(ctx, `SELECT data FROM history WHERE user_id=? ORDER BY id DESC LIMIT ?`, user, limit)
}

func (s *Store) rawList(ctx context.Context, q string, args ...any) ([]json.RawMessage, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		out = append(out, json.RawMessage(data))
	}
	return out, rows.Err()
}

// ---- YouTube matches ----

func (s *Store) Match(ctx context.Context, trackID string) (string, bool) {
	var v string
	var manual int
	var at int64
	err := s.db.QueryRowContext(ctx, `SELECT video_id, manual, updated_at FROM yt_match WHERE track_id=?`, trackID).Scan(&v, &manual, &at)
	if err != nil {
		return "", false
	}
	// Automatic matches are re-checked after 60 days (uploads disappear).
	if manual == 0 && time.Since(time.Unix(at, 0)) > 60*24*time.Hour {
		return "", false
	}
	return v, true
}

func (s *Store) SetMatch(ctx context.Context, trackID, videoID string, manual bool) error {
	m := 0
	if manual {
		m = 1
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO yt_match(track_id,video_id,manual,updated_at) VALUES(?,?,?,?)
		ON CONFLICT(track_id) DO UPDATE SET video_id=excluded.video_id, manual=excluded.manual, updated_at=excluded.updated_at
		WHERE yt_match.manual=0 OR excluded.manual=1`, trackID, videoID, m, now())
	return err
}

// ForgetAutoMatch drops an automatic match, only if it still is videoID.
func (s *Store) ForgetAutoMatch(ctx context.Context, trackID, videoID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM yt_match WHERE track_id=? AND video_id=? AND manual=0`, trackID, videoID)
	return err
}

func (s *Store) ForgetMatch(ctx context.Context, trackID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM yt_match WHERE track_id=?`, trackID)
	return err
}

// ---- torrents ----

type torrentRow struct {
	Hash    string
	Title   string
	Magnet  string
	Torrent []byte
	Files   string
}

func (s *Store) PutTorrent(ctx context.Context, t torrentRow) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO torrents(hash,title,magnet,torrent,files,added_at,used_at) VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(hash) DO UPDATE SET title=excluded.title,
		  magnet=CASE WHEN excluded.magnet<>'' THEN excluded.magnet ELSE torrents.magnet END,
		  torrent=COALESCE(excluded.torrent, torrents.torrent),
		  files=CASE WHEN excluded.files<>'' THEN excluded.files ELSE torrents.files END,
		  used_at=excluded.used_at`,
		t.Hash, t.Title, t.Magnet, t.Torrent, t.Files, now(), now())
	return err
}

func (s *Store) SetTorrentFiles(ctx context.Context, hash, files string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE torrents SET files=?, used_at=? WHERE hash=?`, files, now(), hash)
	return err
}

func (s *Store) Torrent(ctx context.Context, hash string) (*torrentRow, error) {
	var t torrentRow
	err := s.db.QueryRowContext(ctx, `SELECT hash,title,magnet,torrent,files FROM torrents WHERE hash=?`, hash).
		Scan(&t.Hash, &t.Title, &t.Magnet, &t.Torrent, &t.Files)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}
