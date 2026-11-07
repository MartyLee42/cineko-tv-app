// Package auth handles authentication: passwords, browser sessions, personal
// API tokens, device credentials, CSRF and the auth HTTP endpoints.
package auth

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/db"
	"martytv/api/internal/users"
)

var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrNotFound           = errors.New("not found")
)

// Disconnector closes live WebSocket connections when credentials are revoked.
// Implemented by the realtime hub.
type Disconnector interface {
	DisconnectSession(sessionID string)
	DisconnectToken(tokenID string)
	DisconnectUser(userID string)
	DisconnectDevice(deviceID string)
}

type noopDisconnector struct{}

func (noopDisconnector) DisconnectSession(string) {}
func (noopDisconnector) DisconnectToken(string)   {}
func (noopDisconnector) DisconnectUser(string)    {}
func (noopDisconnector) DisconnectDevice(string)  {}

type Service struct {
	pool        *pgxpool.Pool
	users       *users.Store
	hasher      *Hasher
	idleTTL     time.Duration
	absoluteTTL time.Duration
	disconnect  Disconnector
	now         func() time.Time
}

func NewService(pool *pgxpool.Pool, u *users.Store, h *Hasher, idleTTL, absoluteTTL time.Duration) *Service {
	return &Service{pool: pool, users: u, hasher: h, idleTTL: idleTTL, absoluteTTL: absoluteTTL,
		disconnect: noopDisconnector{}, now: time.Now}
}

func (s *Service) SetDisconnector(d Disconnector) { s.disconnect = d }
func (s *Service) Hasher() *Hasher                { return s.hasher }

// Authenticate checks a username/password. It always performs one argon2
// verification so timing does not reveal whether the username exists, and
// returns ErrInvalidCredentials for unknown, disabled or wrong-password cases.
func (s *Service) Authenticate(ctx context.Context, username, password string) (*users.User, error) {
	u, err := s.users.ByUsername(ctx, username)
	if err != nil && !errors.Is(err, users.ErrNotFound) {
		return nil, err
	}
	hash := dummyHash
	if u != nil {
		hash = u.PasswordHash
	}
	ok, err := VerifyPassword(ctx, hash, password)
	if err != nil && !errors.Is(err, ErrInvalidHash) {
		return nil, err
	}
	if u == nil || !ok || u.Disabled() {
		return nil, ErrInvalidCredentials
	}
	return u, nil
}

// NewSession is a freshly created browser session; Token is shown only once.
type NewSession struct {
	ID        string
	Token     string
	CSRFToken string
	ExpiresAt time.Time
}

func (s *Service) CreateSession(ctx context.Context, userID, userAgent, ip string) (*NewSession, error) {
	token, hash := s.hasher.NewToken(PrefixSession)
	csrf := RandomString(32)
	now := s.now().UTC()
	abs := now.Add(s.absoluteTTL)
	exp := minTime(now.Add(s.idleTTL), abs)
	var id string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO user_sessions (user_id, token_hash, csrf_token, user_agent, ip, created_at, last_seen_at, expires_at, absolute_expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8) RETURNING id`,
		userID, hash, csrf, truncate(userAgent, 256), ip, now, exp, abs).Scan(&id)
	if err != nil {
		return nil, err
	}
	return &NewSession{ID: id, Token: token, CSRFToken: csrf, ExpiresAt: exp}, nil
}

// ResolveSession validates a session cookie and slides its idle expiry.
func (s *Service) ResolveSession(ctx context.Context, token string) (*Principal, error) {
	if !strings.HasPrefix(token, PrefixSession) {
		return nil, ErrNotFound
	}
	var p Principal
	var lastSeen, abs time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT s.id, s.csrf_token, s.last_seen_at, s.absolute_expires_at, u.id, u.username, u.role
		FROM user_sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.revoked_at IS NULL
		  AND s.expires_at > now() AND s.absolute_expires_at > now()
		  AND u.disabled_at IS NULL`, s.hasher.Hash(token)).
		Scan(&p.SessionID, &p.CSRFToken, &lastSeen, &abs, &p.UserID, &p.Username, &p.Role)
	if db.IsNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	p.Kind = KindSession
	now := s.now().UTC()
	if now.Sub(lastSeen) > time.Minute {
		_, _ = s.pool.Exec(ctx, `UPDATE user_sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1`,
			p.SessionID, now, minTime(now.Add(s.idleTTL), abs))
	}
	return &p, nil
}

// ResolveAPIToken validates a personal API token.
func (s *Service) ResolveAPIToken(ctx context.Context, token string) (*Principal, error) {
	if !strings.HasPrefix(token, PrefixAPI) {
		return nil, ErrNotFound
	}
	var p Principal
	var lastUsed *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT t.id, t.scopes, t.last_used_at, u.id, u.username, u.role
		FROM api_tokens t JOIN users u ON u.id = t.user_id
		WHERE t.token_hash = $1 AND t.revoked_at IS NULL
		  AND (t.expires_at IS NULL OR t.expires_at > now())
		  AND u.disabled_at IS NULL`, s.hasher.Hash(token)).
		Scan(&p.TokenID, &p.Scopes, &lastUsed, &p.UserID, &p.Username, &p.Role)
	if db.IsNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	p.Kind = KindToken
	if lastUsed == nil || s.now().Sub(*lastUsed) > time.Minute {
		_, _ = s.pool.Exec(ctx, `UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, p.TokenID)
	}
	return &p, nil
}

// ResolveDeviceCredential validates a TV device credential.
func (s *Service) ResolveDeviceCredential(ctx context.Context, token string) (*Principal, error) {
	if !strings.HasPrefix(token, PrefixDevice) {
		return nil, ErrNotFound
	}
	var p Principal
	var credID string
	var lastUsed *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT c.id, c.last_used_at, d.id, d.demo, u.id, u.username, u.role
		FROM device_credentials c
		JOIN devices d ON d.id = c.device_id
		JOIN users u ON u.id = d.owner_user_id
		WHERE c.token_hash = $1 AND c.revoked_at IS NULL AND d.revoked_at IS NULL
		  AND u.disabled_at IS NULL
		  AND (c.expires_at IS NULL OR c.expires_at > now())
		  -- A demo TV (/demo_tv) lives only as long as its browser session.
		  AND (NOT d.demo OR EXISTS (SELECT 1 FROM user_sessions s
		       WHERE s.id = d.demo_session_id AND s.user_id = d.owner_user_id AND s.revoked_at IS NULL
		         AND s.expires_at > now() AND s.absolute_expires_at > now()))`, s.hasher.Hash(token)).
		Scan(&credID, &lastUsed, &p.DeviceID, &p.Demo, &p.UserID, &p.Username, &p.Role)
	if db.IsNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	p.Kind = KindDevice
	if lastUsed == nil || s.now().Sub(*lastUsed) > time.Minute {
		_, _ = s.pool.Exec(ctx, `UPDATE device_credentials SET last_used_at = now() WHERE id = $1`, credID)
		_, _ = s.pool.Exec(ctx, `UPDATE devices SET last_seen_at = now() WHERE id = $1`, p.DeviceID)
	}
	return &p, nil
}

// ResolveBearer dispatches on the token prefix.
func (s *Service) ResolveBearer(ctx context.Context, token string) (*Principal, error) {
	switch {
	case strings.HasPrefix(token, PrefixAPI):
		return s.ResolveAPIToken(ctx, token)
	case strings.HasPrefix(token, PrefixDevice):
		return s.ResolveDeviceCredential(ctx, token)
	default:
		return nil, ErrNotFound
	}
}

// RevokeSession revokes one of the user's sessions.
func (s *Service) RevokeSession(ctx context.Context, userID, sessionID string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE user_sessions SET revoked_at = now()
		WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, sessionID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	s.disconnect.DisconnectSession(sessionID)
	return nil
}

// RevokeAllForUser logs a user out everywhere. With includeDevices it also
// unpairs every TV they own and revokes API tokens.
func (s *Service) RevokeAllForUser(ctx context.Context, userID string, includeDevices bool) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, userID); err != nil {
		return err
	}
	var deviceIDs []string
	if includeDevices {
		if _, err := tx.Exec(ctx, `UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, userID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `UPDATE devices SET revoked_at = now() WHERE owner_user_id = $1 AND revoked_at IS NULL RETURNING id`, userID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			deviceIDs = append(deviceIDs, id)
		}
		rows.Close()
		if _, err := tx.Exec(ctx, `UPDATE device_credentials c SET revoked_at = now() FROM devices d
			WHERE c.device_id = d.id AND d.owner_user_id = $1 AND c.revoked_at IS NULL`, userID); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.disconnect.DisconnectUser(userID)
	for _, id := range deviceIDs {
		s.disconnect.DisconnectDevice(id)
	}
	return nil
}

// SessionInfo is a session as shown in "where you're logged in".
type SessionInfo struct {
	ID         string    `json:"id"`
	UserAgent  string    `json:"user_agent"`
	IP         string    `json:"ip"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
	ExpiresAt  time.Time `json:"expires_at"`
	Current    bool      `json:"current"`
}

func (s *Service) ListSessions(ctx context.Context, userID, currentID string) ([]SessionInfo, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, user_agent, ip, created_at, last_seen_at, expires_at FROM user_sessions
		WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND absolute_expires_at > now()
		ORDER BY last_seen_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SessionInfo
	for rows.Next() {
		var si SessionInfo
		if err := rows.Scan(&si.ID, &si.UserAgent, &si.IP, &si.CreatedAt, &si.LastSeenAt, &si.ExpiresAt); err != nil {
			return nil, err
		}
		si.Current = si.ID == currentID
		out = append(out, si)
	}
	return out, rows.Err()
}

// ChangePassword verifies the current password, sets the new one and revokes
// every other session.
func (s *Service) ChangePassword(ctx context.Context, userID, keepSessionID, current, next string) error {
	u, err := s.users.ByID(ctx, userID)
	if err != nil {
		return err
	}
	ok, err := VerifyPassword(ctx, u.PasswordHash, current)
	if err != nil {
		return err
	}
	if !ok {
		return ErrInvalidCredentials
	}
	return s.SetPassword(ctx, userID, next, keepSessionID)
}

// SetPassword replaces a password and revokes all sessions except keepSessionID.
func (s *Service) SetPassword(ctx context.Context, userID, password, keepSessionID string) error {
	hash, err := HashPassword(ctx, password)
	if err != nil {
		return err
	}
	if err := s.users.SetPassword(ctx, userID, hash); err != nil {
		return err
	}
	rows, err := s.pool.Query(ctx, `UPDATE user_sessions SET revoked_at = now()
		WHERE user_id = $1 AND revoked_at IS NULL AND id::text <> $2 RETURNING id`, userID, keepSessionID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			s.disconnect.DisconnectSession(id)
		}
	}
	return rows.Err()
}

// APIToken is a personal API token as listed to its owner (never the secret).
type APIToken struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	Scopes     []string   `json:"scopes"`
	ExpiresAt  *time.Time `json:"expires_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
	CreatedAt  time.Time  `json:"created_at"`
}

// CreateAPIToken issues a token; the plaintext is returned once.
func (s *Service) CreateAPIToken(ctx context.Context, userID, role, name string, scopes []string, expiresAt *time.Time) (*APIToken, string, error) {
	for _, sc := range scopes {
		if !slices.Contains(AllScopes, sc) {
			return nil, "", errors.New("unknown scope " + sc)
		}
		if sc == ScopeAdmin && !IsAdminRole(role) {
			return nil, "", errors.New("admin scope requires an administrator account")
		}
	}
	token, hash := s.hasher.NewToken(PrefixAPI)
	t := APIToken{Name: name, Prefix: DisplayPrefix(token), Scopes: scopes, ExpiresAt: expiresAt}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, scopes, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
		userID, name, hash, t.Prefix, scopes, expiresAt).Scan(&t.ID, &t.CreatedAt)
	if err != nil {
		return nil, "", err
	}
	return &t, token, nil
}

func (s *Service) ListAPITokens(ctx context.Context, userID string) ([]APIToken, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, token_prefix, scopes, expires_at, last_used_at, created_at FROM api_tokens
		WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
		ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []APIToken
	for rows.Next() {
		var t APIToken
		if err := rows.Scan(&t.ID, &t.Name, &t.Prefix, &t.Scopes, &t.ExpiresAt, &t.LastUsedAt, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Service) RevokeAPIToken(ctx context.Context, userID, tokenID string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE api_tokens SET revoked_at = now()
		WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, tokenID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	s.disconnect.DisconnectToken(tokenID)
	return nil
}

// Cleanup deletes long-expired sessions and tokens. Run periodically.
func (s *Service) Cleanup(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM user_sessions WHERE absolute_expires_at < now() - interval '7 days'
		OR expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`)
	if err != nil {
		return err
	}
	// Demo TVs (/demo_tv) whose session ended are unpaired (the row stays for
	// the watch history); their spent credentials go away.
	if _, err := s.pool.Exec(ctx, `UPDATE devices d SET revoked_at = now()
		WHERE d.demo AND d.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM user_sessions s
		  WHERE s.id = d.demo_session_id AND s.revoked_at IS NULL AND s.expires_at > now() AND s.absolute_expires_at > now())`); err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `DELETE FROM device_credentials c USING devices d
		WHERE c.device_id = d.id AND d.demo AND (c.expires_at < now() OR c.revoked_at IS NOT NULL OR d.revoked_at IS NOT NULL)`)
	return err
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
