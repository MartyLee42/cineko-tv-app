package devices

import (
	"context"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
)

// «Демо TV» (/demo_tv): the TV app opened in a browser that is signed in to
// the PWA, without pairing. The browser session gets a hidden device of its
// own (devices.demo) and short-lived credentials for it, so the TV app runs
// unchanged with its usual Bearer credential. The device:
//   - belongs to the session's user and is never shared, so it reaches only
//     what that user's own TV would (the user's own profiles);
//   - works only while the session does (auth.ResolveDeviceCredential) and
//     its credentials expire after DemoCredentialTTL (the app asks again);
//   - is left out of device lists, remote targets, the admin TV list,
//     metrics, health samples and realtime (no socket, so no presence).
const (
	DemoCredentialTTL = 12 * time.Hour
	// demoMaxCredentials bounds live credentials per demo device (one per tab).
	demoMaxCredentials = 5
	demoDeviceName     = "Демо TV"
)

// DemoCredential is a freshly issued demo credential (shown once).
type DemoCredential struct {
	DeviceID   string    `json:"device_id"`
	Credential string    `json:"credential"`
	ExpiresAt  time.Time `json:"expires_at"`
	created    bool
}

// IssueDemo returns a new credential for the session's demo device, creating
// the device on first use.
func (s *Store) IssueDemo(ctx context.Context, ownerID, sessionID, userAgent string) (*DemoCredential, error) {
	var out DemoCredential
	err := s.q.QueryRow(ctx, `
		INSERT INTO devices (owner_user_id, name, platform, user_agent, last_seen_at, demo, demo_session_id)
		VALUES ($1, $2, 'browser', $3, now(), true, $4)
		ON CONFLICT (demo_session_id) WHERE demo AND revoked_at IS NULL DO UPDATE SET last_seen_at = now()
		RETURNING id, (xmax = 0)`, ownerID, demoDeviceName, userAgent, sessionID).Scan(&out.DeviceID, &out.created)
	if err != nil {
		return nil, err
	}
	// Spent credentials go; the newest few stay valid (other open tabs).
	if _, err := s.q.Exec(ctx, `DELETE FROM device_credentials
		WHERE device_id = $1 AND (revoked_at IS NOT NULL OR expires_at < now())`, out.DeviceID); err != nil {
		return nil, err
	}
	if _, err := s.q.Exec(ctx, `UPDATE device_credentials SET revoked_at = now()
		WHERE device_id = $1 AND revoked_at IS NULL AND id NOT IN (
			SELECT id FROM device_credentials WHERE device_id = $1 AND revoked_at IS NULL
			ORDER BY created_at DESC LIMIT $2)`, out.DeviceID, demoMaxCredentials-1); err != nil {
		return nil, err
	}
	token, hash := s.hasher.NewToken(auth.PrefixDevice)
	out.Credential = token
	err = s.q.QueryRow(ctx, `INSERT INTO device_credentials (device_id, token_hash, expires_at)
		VALUES ($1, $2, now() + make_interval(secs => $3)) RETURNING expires_at`,
		out.DeviceID, hash, DemoCredentialTTL.Seconds()).Scan(&out.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// demo is POST /devices/demo: browser sessions only (CSRF-checked by the
// global middleware), never API tokens or TVs.
func (h *Handlers) demo(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	dc, err := h.store.IssueDemo(c.Context(), p.UserID, p.SessionID, truncate(c.Get(fiber.HeaderUserAgent), 256))
	if err != nil {
		return err
	}
	if dc.created {
		h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, DeviceID: dc.DeviceID, Action: "device.demo_created",
			TargetType: "session", TargetID: p.SessionID, IP: c.IP(), RequestID: httpx.RequestID(c)})
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.Status(fiber.StatusCreated).JSON(dc)
}
