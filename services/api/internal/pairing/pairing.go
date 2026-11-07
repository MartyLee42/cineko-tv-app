// Package pairing implements TV activation: the TV opens a short-lived
// request, a signed-in user approves it from a phone or browser, and the TV
// exchanges it (once) for a device credential. See docs/pairing.md.
package pairing

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/auth"
	"martytv/api/internal/db"
	"martytv/api/internal/devices"
	"martytv/api/internal/profiles"
)

const (
	StatusPending  = "pending"
	StatusApproved = "approved"
	StatusDenied   = "denied"
	StatusConsumed = "consumed"
	StatusExpired  = "expired" // derived, never stored

	// codeAlphabet omits look-alike characters (0/O, 1/I/L): 31 symbols,
	// 8 characters ≈ 39.6 bits. Codes live 5 minutes and lookups are rate limited.
	codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	codeLen      = 8
	// ExchangeGrace is how long a TV has to collect its credential after approval.
	ExchangeGrace = 2 * time.Minute
)

var (
	ErrNotFound    = errors.New("pairing request not found")
	ErrBadSecret   = errors.New("pairing secret mismatch")
	ErrNotPending  = errors.New("pairing request is no longer pending")
	ErrNotApproved = errors.New("pairing request is not approved")
	ErrExpired     = errors.New("pairing request expired")
	ErrConsumed    = errors.New("pairing request already used")
	ErrBadProfile  = errors.New("profile does not belong to approver")
)

type Service struct {
	pool   *pgxpool.Pool
	hasher *auth.Hasher
	ttl    time.Duration
	now    func() time.Time
	// NewTVDesign (config NEW_TV_DESIGN) marks each TV created here with a
	// default design for all its profiles (profiles.DefaultDesignKey);
	// "" = none, the TV shows the profiles' own designs.
	NewTVDesign string
}

func NewService(pool *pgxpool.Pool, h *auth.Hasher, ttl time.Duration) *Service {
	return &Service{pool: pool, hasher: h, ttl: ttl, now: time.Now}
}

// Request is what the TV receives when it starts pairing. PollSecret binds
// later status checks and the credential exchange to this TV; it is never
// shown in the QR code.
type Request struct {
	ID         string    `json:"pairing_id"`
	UserCode   string    `json:"user_code"`
	PollSecret string    `json:"poll_secret"`
	ExpiresAt  time.Time `json:"expires_at"`
}

// Create opens a new pairing request.
func (s *Service) Create(ctx context.Context, deviceName, platform, userAgent, ip string) (*Request, error) {
	secret := auth.RandomString(32)
	exp := s.now().UTC().Add(s.ttl)
	for range 5 {
		code := NewUserCode()
		var id string
		err := s.pool.QueryRow(ctx, `
			INSERT INTO pairing_sessions (user_code, poll_secret_hash, device_name, platform, user_agent, ip, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
			code, s.hasher.Hash(secret), deviceName, platform, userAgent, ip, exp).Scan(&id)
		if db.IsUniqueViolation(err) {
			continue // astronomically rare code collision; try another
		}
		if err != nil {
			return nil, err
		}
		return &Request{ID: id, UserCode: code, PollSecret: secret, ExpiresAt: exp}, nil
	}
	return nil, errors.New("could not allocate pairing code")
}

// NewUserCode returns an 8-character code from codeAlphabet.
func NewUserCode() string {
	// Rejection sampling keeps every symbol equally likely.
	limit := byte(256 - 256%len(codeAlphabet))
	out := make([]byte, 0, codeLen)
	buf := make([]byte, 16)
	for len(out) < codeLen {
		_, _ = rand.Read(buf)
		for _, v := range buf {
			if v < limit && len(out) < codeLen {
				out = append(out, codeAlphabet[int(v)%len(codeAlphabet)])
			}
		}
	}
	return string(out)
}

// NormalizeCode uppercases a typed code and strips separators and spaces.
func NormalizeCode(s string) string {
	s = strings.ToUpper(s)
	var b strings.Builder
	for _, r := range s {
		if strings.ContainsRune(codeAlphabet, r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// FormatCode renders a code as ABCD-EFGH for display.
func FormatCode(code string) string {
	if len(code) == codeLen {
		return code[:4] + "-" + code[4:]
	}
	return code
}

type session struct {
	ID               string
	UserCode         string
	PollSecretHash   []byte
	DeviceName       string
	Platform         string
	IP               string
	Status           string
	ApprovedBy       *string
	ApprovedName     *string
	DefaultProfileID *string
	DeviceID         *string
	CreatedAt        time.Time
	ExpiresAt        time.Time
}

const sessionCols = `id, user_code, poll_secret_hash, device_name, platform, ip, status,
	approved_by_user_id, approved_name, default_profile_id, device_id, created_at, expires_at`

func scanSession(row pgx.Row) (*session, error) {
	var s session
	err := row.Scan(&s.ID, &s.UserCode, &s.PollSecretHash, &s.DeviceName, &s.Platform, &s.IP, &s.Status,
		&s.ApprovedBy, &s.ApprovedName, &s.DefaultProfileID, &s.DeviceID, &s.CreatedAt, &s.ExpiresAt)
	if db.IsNoRows(err) {
		return nil, ErrNotFound
	}
	return &s, err
}

func (s *Service) effectiveStatus(ps *session) string {
	if (ps.Status == StatusPending || ps.Status == StatusApproved) && !s.now().Before(ps.ExpiresAt) {
		return StatusExpired
	}
	return ps.Status
}

// Pending is what an approver sees before confirming.
type Pending struct {
	ID         string    `json:"pairing_id"`
	UserCode   string    `json:"user_code"`
	DeviceName string    `json:"device_name"`
	Platform   string    `json:"platform"`
	IP         string    `json:"ip"`
	CreatedAt  time.Time `json:"created_at"`
	ExpiresAt  time.Time `json:"expires_at"`
}

// Lookup finds a still-pending request by its user code.
func (s *Service) Lookup(ctx context.Context, code string) (*Pending, error) {
	code = NormalizeCode(code)
	if len(code) != codeLen {
		return nil, ErrNotFound
	}
	ps, err := scanSession(s.pool.QueryRow(ctx, `SELECT `+sessionCols+` FROM pairing_sessions
		WHERE user_code = $1 AND status = 'pending'`, code))
	if err != nil {
		return nil, err
	}
	if s.effectiveStatus(ps) != StatusPending {
		return nil, ErrNotFound
	}
	return &Pending{ID: ps.ID, UserCode: FormatCode(ps.UserCode), DeviceName: ps.DeviceName,
		Platform: ps.Platform, IP: ps.IP, CreatedAt: ps.CreatedAt, ExpiresAt: ps.ExpiresAt}, nil
}

// Approve marks a pending request approved by userID. name overrides the
// device name; defaultProfileID must be one of the approver's profiles.
func (s *Service) Approve(ctx context.Context, id, userID, name string, defaultProfileID *string) error {
	if defaultProfileID != nil {
		var ok bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2)`,
			*defaultProfileID, userID).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return ErrBadProfile
		}
	}
	now := s.now().UTC()
	tag, err := s.pool.Exec(ctx, `
		UPDATE pairing_sessions SET status = 'approved', approved_by_user_id = $2, approved_name = $3,
			default_profile_id = $4, decided_at = $5, expires_at = $6
		WHERE id = $1 AND status = 'pending' AND expires_at > $5`,
		id, userID, name, defaultProfileID, now, now.Add(ExchangeGrace))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotPending
	}
	return nil
}

// Deny rejects a pending request.
func (s *Service) Deny(ctx context.Context, id, userID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE pairing_sessions SET status = 'denied', approved_by_user_id = $2, decided_at = now()
		WHERE id = $1 AND status = 'pending' AND expires_at > now()`, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotPending
	}
	return nil
}

// Status returns the request's status to the TV that created it.
func (s *Service) Status(ctx context.Context, id, secret string) (string, time.Time, error) {
	ps, err := scanSession(s.pool.QueryRow(ctx, `SELECT `+sessionCols+` FROM pairing_sessions WHERE id = $1`, id))
	if err != nil {
		return "", time.Time{}, err
	}
	if !s.secretMatches(ps, secret) {
		return "", time.Time{}, ErrBadSecret
	}
	return s.effectiveStatus(ps), ps.ExpiresAt, nil
}

// Exchange converts an approved request into a device and credential. It
// succeeds exactly once per request.
func (s *Service) Exchange(ctx context.Context, id, secret, userAgent string) (*devices.NewDevice, string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback(ctx)
	ps, err := scanSession(tx.QueryRow(ctx, `SELECT `+sessionCols+` FROM pairing_sessions WHERE id = $1 FOR UPDATE`, id))
	if err != nil {
		return nil, "", err
	}
	if !s.secretMatches(ps, secret) {
		return nil, "", ErrBadSecret
	}
	switch s.effectiveStatus(ps) {
	case StatusApproved:
	case StatusConsumed:
		return nil, "", ErrConsumed
	case StatusExpired:
		return nil, "", ErrExpired
	default:
		return nil, "", ErrNotApproved
	}
	name := ps.DeviceName
	if ps.ApprovedName != nil && *ps.ApprovedName != "" {
		name = *ps.ApprovedName
	}
	nd, err := devices.Register(ctx, tx, s.hasher, *ps.ApprovedBy, name, ps.Platform, userAgent, ps.DefaultProfileID)
	if err != nil {
		return nil, "", err
	}
	if s.NewTVDesign != "" && profiles.IsDesign(s.NewTVDesign) {
		if _, err := tx.Exec(ctx, `UPDATE devices SET settings = settings || jsonb_build_object($2::text, $3::text) WHERE id = $1`,
			nd.Device.ID, profiles.DefaultDesignKey, s.NewTVDesign); err != nil {
			return nil, "", err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE pairing_sessions SET status = 'consumed', consumed_at = now(), device_id = $2
		WHERE id = $1`, id, nd.Device.ID); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return nd, *ps.ApprovedBy, nil
}

// Cleanup removes requests that ended more than a day ago.
func (s *Service) Cleanup(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM pairing_sessions WHERE expires_at < now() - interval '1 day'`)
	return err
}

func (s *Service) secretMatches(ps *session, secret string) bool {
	return secret != "" && subtle.ConstantTimeCompare(ps.PollSecretHash, s.hasher.Hash(secret)) == 1
}
