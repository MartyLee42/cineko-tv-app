// Package users stores accounts and serves the admin user-management API.
package users

import (
	"context"
	"errors"
	"regexp"
	"time"

	"martytv/api/internal/db"
)

var ErrNotFound = errors.New("user not found")
var ErrUsernameTaken = errors.New("username taken")

var UsernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{3,32}$`)

// Roles, from least to most privileged: user < admin < super_admin.
const (
	RoleUser       = "user"
	RoleAdmin      = "admin"
	RoleSuperAdmin = "super_admin"
)

// ValidRole reports whether role is one of the known roles.
func ValidRole(role string) bool {
	return role == RoleUser || role == RoleAdmin || role == RoleSuperAdmin
}

// IsAdminRole reports administrator rights (admin or super_admin).
func IsAdminRole(role string) bool { return role == RoleAdmin || role == RoleSuperAdmin }

type User struct {
	ID           string     `json:"id"`
	Username     string     `json:"username"`
	DisplayName  string     `json:"display_name"`
	Role         string     `json:"role"`
	PasswordHash string     `json:"-"`
	DisabledAt   *time.Time `json:"disabled_at"`
	CreatedAt    time.Time  `json:"created_at"`
}

func (u *User) Disabled() bool { return u.DisabledAt != nil }

type Store struct{ q db.Querier }

func NewStore(q db.Querier) *Store { return &Store{q: q} }

const cols = `id, username, display_name, role, password_hash, disabled_at, created_at`

func scan(row interface{ Scan(...any) error }) (*User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.PasswordHash, &u.DisabledAt, &u.CreatedAt)
	if db.IsNoRows(err) {
		return nil, ErrNotFound
	}
	return &u, err
}

func (s *Store) ByID(ctx context.Context, id string) (*User, error) {
	return scan(s.q.QueryRow(ctx, `SELECT `+cols+` FROM users WHERE id = $1`, id))
}

func (s *Store) ByUsername(ctx context.Context, username string) (*User, error) {
	return scan(s.q.QueryRow(ctx, `SELECT `+cols+` FROM users WHERE lower(username) = lower($1)`, username))
}

func (s *Store) Create(ctx context.Context, username, displayName, role, passwordHash string) (*User, error) {
	u, err := scan(s.q.QueryRow(ctx, `
		INSERT INTO users (username, display_name, role, password_hash)
		VALUES ($1, $2, $3, $4) RETURNING `+cols, username, displayName, role, passwordHash))
	if db.IsUniqueViolation(err) {
		return nil, ErrUsernameTaken
	}
	return u, err
}

func (s *Store) List(ctx context.Context) ([]User, error) {
	rows, err := s.q.Query(ctx, `SELECT `+cols+` FROM users ORDER BY lower(username)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		u, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *u)
	}
	return out, rows.Err()
}

func (s *Store) Count(ctx context.Context) (int, error) {
	var n int
	err := s.q.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

// CountActiveAdmins counts enabled administrators (admin or super_admin).
func (s *Store) CountActiveAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.q.QueryRow(ctx, `SELECT count(*) FROM users WHERE role IN ('admin', 'super_admin') AND disabled_at IS NULL`).Scan(&n)
	return n, err
}

// CountActiveSuperAdmins counts enabled super_admins.
func (s *Store) CountActiveSuperAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.q.QueryRow(ctx, `SELECT count(*) FROM users WHERE role = 'super_admin' AND disabled_at IS NULL`).Scan(&n)
	return n, err
}

func (s *Store) SetPassword(ctx context.Context, id, hash string) error {
	return s.exec(ctx, `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, id, hash)
}

func (s *Store) SetDisabled(ctx context.Context, id string, disabled bool) error {
	return s.exec(ctx, `UPDATE users SET disabled_at = CASE WHEN $2 THEN coalesce(disabled_at, now()) END,
		updated_at = now() WHERE id = $1`, id, disabled)
}

func (s *Store) SetRole(ctx context.Context, id, role string) error {
	return s.exec(ctx, `UPDATE users SET role = $2, updated_at = now() WHERE id = $1`, id, role)
}

func (s *Store) SetDisplayName(ctx context.Context, id, name string) error {
	return s.exec(ctx, `UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1`, id, name)
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

// CreateDefaultProfile gives a new account its first viewing profile (named
// after the user) so a freshly paired TV never shows an empty profile picker.
func (s *Store) CreateDefaultProfile(ctx context.Context, u *User) error {
	name := u.DisplayName
	if name == "" {
		name = u.Username
	}
	if len([]rune(name)) > 32 {
		name = string([]rune(name)[:32])
	}
	_, err := s.q.Exec(ctx, `
		WITH p AS (
			INSERT INTO profiles (user_id, name) VALUES ($1, $2) RETURNING id
		) INSERT INTO profile_preferences (profile_id) SELECT id FROM p`, u.ID, name)
	return err
}

var (
	ErrLastAdmin      = errors.New("at least one active administrator is required")
	ErrLastSuperAdmin = errors.New("at least one active super admin is required")
)

// GuardLockout refuses a change that would leave no active administrator or
// no active super_admin: target becoming newRole ("" = unchanged) and/or
// being disabled. Disabled targets don't count, so changing them is fine.
func (s *Store) GuardLockout(ctx context.Context, target *User, newRole string, disabling bool) error {
	if target.Disabled() {
		return nil
	}
	if newRole == "" {
		newRole = target.Role
	}
	if target.Role == RoleSuperAdmin && (newRole != RoleSuperAdmin || disabling) {
		n, err := s.CountActiveSuperAdmins(ctx)
		if err != nil {
			return err
		}
		if n <= 1 {
			return ErrLastSuperAdmin
		}
	}
	if IsAdminRole(target.Role) && (!IsAdminRole(newRole) || disabling) {
		n, err := s.CountActiveAdmins(ctx)
		if err != nil {
			return err
		}
		if n <= 1 {
			return ErrLastAdmin
		}
	}
	return nil
}

// CanManage reports whether a caller with callerRole may change another
// account with targetRole (disable, reset password, rename, change role).
// A super_admin manages everyone; a plain admin only regular users.
func CanManage(callerRole, targetRole string) bool {
	switch callerRole {
	case RoleSuperAdmin:
		return true
	case RoleAdmin:
		return targetRole == RoleUser
	}
	return false
}

// CanGrant reports whether callerRole may give an account newRole: only a
// super_admin grants (or revokes) admin and super_admin.
func CanGrant(callerRole, newRole string) bool {
	return callerRole == RoleSuperAdmin || (callerRole == RoleAdmin && newRole == RoleUser)
}
