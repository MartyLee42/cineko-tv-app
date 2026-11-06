package playback

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"martytv/api/internal/db"
	"martytv/api/internal/releases"
)

var errNotFound = errors.New("not found")

// source is a playback_sources row.
type source struct {
	ID              string
	MediaID         string
	EpisodeID       *string
	ReleaseID       string
	Release         releases.Release
	InfoHash        string
	Magnet          *string
	FileIndex       *int
	FilePath        *string
	FileSize        *int64
	Files           []fileStat
	Status          string
	ErrorCode       *string
	MediaInfo       *MediaInfo
	CreatedByUserID string
	DeviceID        *string
	ProfileID       *string
	CreatedAt       time.Time
	UpdatedAt       time.Time
	// Online sources (kind "online"): provider id and the server-only ref.
	Kind      string
	Provider  *string
	OnlineRef []byte
}

const sourceCols = `id, media_id, episode_id, release_id, release, COALESCE(info_hash, ''), magnet, file_index, file_path,
	file_size, files, status, error_code, media_info, created_by_user_id, device_id, profile_id, created_at, updated_at,
	kind, provider, online_ref`

func scanSource(row pgx.Row) (*source, error) {
	var s source
	var rel, files, mi []byte
	err := row.Scan(&s.ID, &s.MediaID, &s.EpisodeID, &s.ReleaseID, &rel, &s.InfoHash, &s.Magnet, &s.FileIndex,
		&s.FilePath, &s.FileSize, &files, &s.Status, &s.ErrorCode, &mi, &s.CreatedByUserID, &s.DeviceID,
		&s.ProfileID, &s.CreatedAt, &s.UpdatedAt, &s.Kind, &s.Provider, &s.OnlineRef)
	if db.IsNoRows(err) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(rel, &s.Release)
	if len(files) > 0 {
		_ = json.Unmarshal(files, &s.Files)
	}
	if len(mi) > 0 && string(mi) != "null" {
		s.MediaInfo = &MediaInfo{}
		if json.Unmarshal(mi, s.MediaInfo) != nil {
			s.MediaInfo = nil
		}
	}
	return &s, nil
}

type store struct{ q db.Querier }

func (st *store) get(ctx context.Context, id string) (*source, error) {
	return scanSource(st.q.QueryRow(ctx, `SELECT `+sourceCols+` FROM playback_sources WHERE id = $1`, id))
}

func (st *store) findReusable(ctx context.Context, userID, hash string, episodeID *string) (*source, error) {
	return scanSource(st.q.QueryRow(ctx, `SELECT `+sourceCols+` FROM playback_sources
		WHERE kind = 'torrent' AND created_by_user_id = $1 AND info_hash = $2 AND episode_id IS NOT DISTINCT FROM $3`, userID, hash, episodeID))
}

// insertOrGet inserts a new preparing source or returns the existing one for
// the same (user, hash, episode); created reports which happened.
func (st *store) insertOrGet(ctx context.Context, s *source) (*source, bool, error) {
	rel, _ := json.Marshal(s.Release)
	row := st.q.QueryRow(ctx, `INSERT INTO playback_sources
		(media_id, episode_id, release_id, release, info_hash, magnet, created_by_user_id, device_id, profile_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (created_by_user_id, info_hash, episode_id) WHERE kind = 'torrent' DO NOTHING
		RETURNING `+sourceCols,
		s.MediaID, s.EpisodeID, s.ReleaseID, rel, s.InfoHash, s.Magnet, s.CreatedByUserID, s.DeviceID, s.ProfileID)
	out, err := scanSource(row)
	if err == nil {
		return out, true, nil
	}
	if !errors.Is(err, errNotFound) {
		return nil, false, err
	}
	out, err = st.findReusable(ctx, s.CreatedByUserID, s.InfoHash, s.EpisodeID)
	return out, false, err
}

// restart resets a failed source to preparing (retry with fresh release data).
func (st *store) restart(ctx context.Context, id string, s *source) error {
	rel, _ := json.Marshal(s.Release)
	_, err := st.q.Exec(ctx, `UPDATE playback_sources SET status = 'preparing', error_code = NULL,
		release_id = $2, release = $3, magnet = COALESCE($4, magnet), device_id = COALESCE($5, device_id),
		profile_id = COALESCE($6, profile_id), updated_at = now()
		WHERE id = $1 AND status = 'error'`, id, s.ReleaseID, rel, s.Magnet, s.DeviceID, s.ProfileID)
	return err
}

func (st *store) setFiles(ctx context.Context, id string, files []fileStat) error {
	b, _ := json.Marshal(files)
	_, err := st.q.Exec(ctx, `UPDATE playback_sources SET files = $2, updated_at = now() WHERE id = $1`, id, b)
	return err
}

func (st *store) setReady(ctx context.Context, id string, f TorrentFile) error {
	_, err := st.q.Exec(ctx, `UPDATE playback_sources SET status = 'ready', error_code = NULL, file_index = $2,
		file_path = $3, file_size = $4, media_info = CASE WHEN file_index IS DISTINCT FROM $2 THEN NULL ELSE media_info END,
		ready_at = COALESCE(ready_at, now()), updated_at = now() WHERE id = $1`, id, f.Index, f.Path, f.SizeBytes)
	return err
}

func (st *store) setError(ctx context.Context, id, code string) error {
	_, err := st.q.Exec(ctx, `UPDATE playback_sources SET status = 'error', error_code = $2, updated_at = now()
		WHERE id = $1 AND status = 'preparing'`, id, code)
	return err
}

func (st *store) setMediaInfo(ctx context.Context, id string, fileIndex int, mi *MediaInfo) error {
	b, _ := json.Marshal(mi)
	_, err := st.q.Exec(ctx, `UPDATE playback_sources SET media_info = $3, updated_at = now()
		WHERE id = $1 AND file_index = $2`, id, fileIndex, b)
	return err
}

// canAccess implements source authorization:
//   - users (session/token): only the creator;
//   - devices: the creating device, or any device owned by or shared with
//     the creator.
func (st *store) canAccess(ctx context.Context, s *source, userID, deviceID string) (bool, error) {
	if deviceID == "" {
		return userID == s.CreatedByUserID, nil
	}
	if s.DeviceID != nil && *s.DeviceID == deviceID {
		return true, nil
	}
	var ok bool
	err := st.q.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM devices d WHERE d.id = $1 AND d.revoked_at IS NULL AND (d.owner_user_id = $2
			OR EXISTS (SELECT 1 FROM device_permissions dp WHERE dp.device_id = d.id AND dp.user_id = $2)))`,
		deviceID, s.CreatedByUserID).Scan(&ok)
	return ok, err
}

type mediaRow struct {
	Kind string
}

func (st *store) media(ctx context.Context, id string) (*mediaRow, error) {
	var m mediaRow
	err := st.q.QueryRow(ctx, `SELECT kind FROM media WHERE id = $1`, id).Scan(&m.Kind)
	if db.IsNoRows(err) {
		return nil, errNotFound
	}
	return &m, err
}

func (st *store) episode(ctx context.Context, mediaID, episodeID string) (season, number int, err error) {
	err = st.q.QueryRow(ctx, `SELECT season_number, episode_number FROM episodes WHERE id = $1 AND media_id = $2`,
		episodeID, mediaID).Scan(&season, &number)
	if db.IsNoRows(err) {
		err = errNotFound
	}
	return
}

func (st *store) profileAccessible(ctx context.Context, profileID, userID, deviceID string) (bool, error) {
	var ok bool
	var err error
	if deviceID != "" {
		err = st.q.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM profiles p JOIN devices d ON d.id = $1
			WHERE p.id = $2 AND (p.user_id = d.owner_user_id OR p.user_id IN
				(SELECT user_id FROM device_permissions WHERE device_id = $1 AND permission = 'use')))`,
			deviceID, profileID).Scan(&ok)
	} else {
		err = st.q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2)`,
			profileID, userID).Scan(&ok)
	}
	return ok, err
}

// filesForHash returns the cached file list of any source of the torrent.
func (st *store) filesForHash(ctx context.Context, hash string) ([]fileStat, error) {
	var b []byte
	err := st.q.QueryRow(ctx, `SELECT files FROM playback_sources WHERE kind = 'torrent' AND info_hash = $1
		AND files IS NOT NULL ORDER BY updated_at DESC LIMIT 1`, hash).Scan(&b)
	if db.IsNoRows(err) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	var out []fileStat
	return out, json.Unmarshal(b, &out)
}
