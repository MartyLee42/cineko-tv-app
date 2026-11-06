// Package devices manages paired TVs: ownership, sharing, credentials.
package devices

import (
	"context"
	"errors"
	"time"

	"martytv/api/internal/auth"
	"martytv/api/internal/db"
)

var (
	ErrNotFound       = errors.New("device not found")
	ErrBadProfile     = errors.New("profile does not belong to the device owner")
	ErrUnknownUser    = errors.New("unknown user")
	ErrShareWithOwner = errors.New("cannot share with owner")
)

// Access levels a user can have on a device, from most to least privileged.
const (
	AccessOwner   = "owner"
	AccessUse     = "use"
	AccessControl = "control"
)

type Device struct {
	ID               string     `json:"id"`
	OwnerUserID      string     `json:"owner_user_id"`
	OwnerUsername    string     `json:"owner_username"`
	Name             string     `json:"name"`
	Platform         string     `json:"platform"`
	DefaultProfileID *string    `json:"default_profile_id"`
	CreatedAt        time.Time  `json:"created_at"`
	LastSeenAt       *time.Time `json:"last_seen_at"`
	Access           string     `json:"access"`
	Online           bool       `json:"online"`
	// Only in GET /devices?scope=all (super_admin): see superplay.go.
	Owner *DeviceOwner `json:"owner,omitempty"`
	Via   string       `json:"via,omitempty"`
}

type Permission struct {
	UserID     string    `json:"user_id"`
	Username   string    `json:"username"`
	Permission string    `json:"permission"`
	CreatedAt  time.Time `json:"created_at"`
}

type Store struct {
	q      db.Querier
	hasher *auth.Hasher
}

func NewStore(q db.Querier, h *auth.Hasher) *Store { return &Store{q: q, hasher: h} }

const selectDevice = `
	SELECT d.id, d.owner_user_id, u.username, d.name, d.platform, d.default_profile_id,
	       d.created_at, d.last_seen_at,
	       CASE WHEN d.owner_user_id = $1 THEN 'owner' ELSE dp.permission END AS access
	FROM devices d
	JOIN users u ON u.id = d.owner_user_id
	LEFT JOIN device_permissions dp ON dp.device_id = d.id AND dp.user_id = $1
	WHERE d.revoked_at IS NULL AND (d.owner_user_id = $1 OR dp.user_id IS NOT NULL)`

func scan(row interface{ Scan(...any) error }) (*Device, error) {
	var d Device
	err := row.Scan(&d.ID, &d.OwnerUserID, &d.OwnerUsername, &d.Name, &d.Platform, &d.DefaultProfileID,
		&d.CreatedAt, &d.LastSeenAt, &d.Access)
	if db.IsNoRows(err) {
		return nil, ErrNotFound
	}
	return &d, err
}

// ListForUser returns devices the user owns or has been granted.
func (s *Store) ListForUser(ctx context.Context, userID string) ([]Device, error) {
	rows, err := s.q.Query(ctx, selectDevice+` ORDER BY (d.owner_user_id = $1) DESC, d.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		d, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// GetForUser returns a device only if userID has any access to it.
func (s *Store) GetForUser(ctx context.Context, userID, deviceID string) (*Device, error) {
	return scan(s.q.QueryRow(ctx, selectDevice+` AND d.id = $2`, userID, deviceID))
}

// GetForDevice returns a device's own record (for the TV itself).
func (s *Store) GetForDevice(ctx context.Context, deviceID string) (*Device, error) {
	return scan(s.q.QueryRow(ctx, `
		SELECT d.id, d.owner_user_id, u.username, d.name, d.platform, d.default_profile_id,
		       d.created_at, d.last_seen_at, 'device'
		FROM devices d JOIN users u ON u.id = d.owner_user_id
		WHERE d.id = $1 AND d.revoked_at IS NULL`, deviceID))
}

// AuthorizedUserIDs returns the owner and every user the device is shared with.
func (s *Store) AuthorizedUserIDs(ctx context.Context, deviceID string) ([]string, error) {
	rows, err := s.q.Query(ctx, `
		SELECT owner_user_id FROM devices WHERE id = $1
		UNION SELECT user_id FROM device_permissions WHERE device_id = $1`, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) Rename(ctx context.Context, ownerID, deviceID, name string) error {
	return s.exec(ctx, `UPDATE devices SET name = $3 WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL`,
		deviceID, ownerID, name)
}

// SetDefaultProfile sets (or clears, with nil) the TV's default profile. The
// profile must belong to the device owner.
func (s *Store) SetDefaultProfile(ctx context.Context, ownerID, deviceID string, profileID *string) error {
	if profileID != nil {
		var ok bool
		if err := s.q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2)`,
			*profileID, ownerID).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return ErrBadProfile
		}
	}
	return s.exec(ctx, `UPDATE devices SET default_profile_id = $3 WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL`,
		deviceID, ownerID, profileID)
}

// Revoke unpairs a device: it and all its credentials stop working.
func (s *Store) Revoke(ctx context.Context, ownerID, deviceID string) error {
	if err := s.exec(ctx, `UPDATE devices SET revoked_at = now() WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL`,
		deviceID, ownerID); err != nil {
		return err
	}
	_, err := s.q.Exec(ctx, `UPDATE device_credentials SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL`, deviceID)
	return err
}

func (s *Store) ListPermissions(ctx context.Context, deviceID string) ([]Permission, error) {
	rows, err := s.q.Query(ctx, `
		SELECT dp.user_id, u.username, dp.permission, dp.created_at
		FROM device_permissions dp JOIN users u ON u.id = dp.user_id
		WHERE dp.device_id = $1 ORDER BY lower(u.username)`, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Permission
	for rows.Next() {
		var p Permission
		if err := rows.Scan(&p.UserID, &p.Username, &p.Permission, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Share grants (or updates) another user's access by username.
func (s *Store) Share(ctx context.Context, ownerID, deviceID, username, permission string) (*Permission, error) {
	var p Permission
	err := s.q.QueryRow(ctx, `
		INSERT INTO device_permissions (device_id, user_id, permission, granted_by_user_id)
		SELECT d.id, u.id, $4, $2 FROM devices d, users u
		WHERE d.id = $1 AND d.owner_user_id = $2 AND d.revoked_at IS NULL
		  AND lower(u.username) = lower($3) AND u.disabled_at IS NULL AND u.id <> d.owner_user_id
		ON CONFLICT (device_id, user_id) DO UPDATE SET permission = EXCLUDED.permission
		RETURNING user_id, $3, permission, created_at`, deviceID, ownerID, username, permission).
		Scan(&p.UserID, &p.Username, &p.Permission, &p.CreatedAt)
	if db.IsNoRows(err) {
		return nil, ErrUnknownUser
	}
	return &p, err
}

func (s *Store) Unshare(ctx context.Context, ownerID, deviceID, userID string) error {
	return s.exec(ctx, `DELETE FROM device_permissions dp USING devices d
		WHERE dp.device_id = d.id AND d.id = $1 AND d.owner_user_id = $2 AND dp.user_id = $3`,
		deviceID, ownerID, userID)
}

// IsOwner reports whether userID owns an active device.
func (s *Store) IsOwner(ctx context.Context, userID, deviceID string) (bool, error) {
	var ok bool
	err := s.q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM devices WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL)`,
		deviceID, userID).Scan(&ok)
	return ok, err
}

// NewDevice is a freshly registered device with its one-time credential.
type NewDevice struct {
	Device     Device
	Credential string
}

// Register creates a device and its credential using q (pass a transaction to
// make this atomic with other work, e.g. consuming a pairing request).
func Register(ctx context.Context, q db.Querier, h *auth.Hasher, ownerID, name, platform, userAgent string, defaultProfileID *string) (*NewDevice, error) {
	var d Device
	err := q.QueryRow(ctx, `
		INSERT INTO devices (owner_user_id, name, platform, user_agent, default_profile_id, last_seen_at)
		VALUES ($1, $2, $3, $4, $5, now())
		RETURNING id, owner_user_id, name, platform, default_profile_id, created_at, last_seen_at`,
		ownerID, name, platform, userAgent, defaultProfileID).
		Scan(&d.ID, &d.OwnerUserID, &d.Name, &d.Platform, &d.DefaultProfileID, &d.CreatedAt, &d.LastSeenAt)
	if err != nil {
		return nil, err
	}
	d.Access = AccessOwner
	token, hash := h.NewToken(auth.PrefixDevice)
	if _, err := q.Exec(ctx, `INSERT INTO device_credentials (device_id, token_hash) VALUES ($1, $2)`, d.ID, hash); err != nil {
		return nil, err
	}
	return &NewDevice{Device: d, Credential: token}, nil
}

func (s *Store) exec(ctx context.Context, sql string, args ...any) error {
	tag, err := s.q.Exec(ctx, sql, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
