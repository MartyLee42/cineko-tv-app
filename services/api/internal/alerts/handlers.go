package alerts

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
)

// InternalRoutes mounts POST /internal/incident on the root app: outside
// /api, so Caddy never publishes it; the host scripts reach it on the
// compose network (docker exec <web> wget http://api:8080/…).
func (s *Service) InternalRoutes(app fiber.Router) {
	app.Post("/internal/incident", s.hostIncident)
}

// AdminRoutes mounts the incidents list and push subscriptions (RequireAdmin).
func (s *Service) AdminRoutes(admin fiber.Router) {
	admin.Get("/incidents", s.list)
	admin.Get("/alerts/push", s.pushStatus)
	admin.Post("/alerts/push", s.subscribe)
	admin.Post("/alerts/push/unsubscribe", s.unsubscribe)
	admin.Post("/alerts/push/test", s.pushTest)
}

func (s *Service) authorized(header string) bool {
	scheme, tok, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || s.d.Token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(strings.TrimSpace(tok)), []byte(s.d.Token)) == 1
}

func (s *Service) hostIncident(c fiber.Ctx) error {
	if s.d.Token == "" {
		return c.SendStatus(fiber.StatusNotFound)
	}
	if !s.authorized(c.Get(fiber.HeaderAuthorization)) {
		return c.SendStatus(fiber.StatusUnauthorized)
	}
	var r HostReport
	if err := httpx.BindJSON(c, &r); err != nil {
		return err
	}
	if err := s.Report(c.Context(), r); err != nil {
		if errors.Is(err, ErrBadReport) {
			return httpx.BadRequest("Unknown kind, state, cause or action.")
		}
		return err
	}
	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{"ok": true})
}

// Incident is one row of GET /admin/incidents.
type Incident struct {
	ID        string     `json:"id"`
	Kind      string     `json:"kind"`
	Cause     string     `json:"cause"`
	Detail    string     `json:"detail"`
	Source    string     `json:"source"`
	Summary   string     `json:"summary"` // what broke, in the requested language
	Notes     []string   `json:"notes"`   // actions taken, localized
	OpenedAt  time.Time  `json:"opened_at"`
	ClosedAt  *time.Time `json:"closed_at"`
	Reminders int        `json:"reminders"`
}

// list: open incidents and those of the last 30 days, newest first.
func (s *Service) list(c fiber.Ctx) error {
	l := NormalizeLocale(c.Query("lang"))
	rows, err := s.d.Pool.Query(c.Context(), `
		SELECT id, kind, cause, detail, source, notes, opened_at, closed_at, reminders FROM incidents
		WHERE closed_at IS NULL OR opened_at > now() - interval '30 days'
		ORDER BY closed_at IS NULL DESC, opened_at DESC LIMIT 300`)
	if err != nil {
		return err
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Incident, error) {
		var x Incident
		var notes []string
		err := r.Scan(&x.ID, &x.Kind, &x.Cause, &x.Detail, &x.Source, &notes, &x.OpenedAt, &x.ClosedAt, &x.Reminders)
		x.Summary = problem(x.Kind, x.Cause, l)
		x.Notes = []string{}
		for _, n := range notes {
			if t, ok := actions[n]; ok {
				x.Notes = append(x.Notes, t.in(l))
			}
		}
		return x, err
	})
	if err != nil {
		return err
	}
	open := 0
	for _, x := range items {
		if x.ClosedAt == nil {
			open++
		}
	}
	if items == nil {
		items = []Incident{}
	}
	return c.JSON(fiber.Map{"items": items, "open": open})
}

func (s *Service) pushStatus(c fiber.Ctx) error {
	v, err := s.VAPID(c.Context())
	if err != nil {
		return err
	}
	p := auth.PrincipalFrom(c)
	var n int
	if err := s.d.Pool.QueryRow(c.Context(), `SELECT count(*) FROM push_subscriptions WHERE user_id = $1`, p.UserID).Scan(&n); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"public_key": v.Public, "subscriptions": n})
}

type subscribeInput struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
	Locale string `json:"locale"`
}

// subscribe stores this browser's subscription (upsert by endpoint).
func (s *Service) subscribe(c fiber.Ctx) error {
	var in subscribeInput
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	sub := Subscription{Endpoint: strings.TrimSpace(in.Endpoint), P256dh: in.Keys.P256dh, Auth: in.Keys.Auth}
	if err := ValidateSubscription(sub); err != nil {
		return httpx.Validation(map[string]string{"endpoint": err.Error()})
	}
	p := auth.PrincipalFrom(c)
	_, err := s.d.Pool.Exec(c.Context(), `
		INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, locale) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
			auth = EXCLUDED.auth, locale = EXCLUDED.locale, failures = 0`,
		p.UserID, sub.Endpoint, sub.P256dh, sub.Auth, NormalizeLocale(in.Locale))
	if err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Service) unsubscribe(c fiber.Ctx) error {
	var in struct {
		Endpoint string `json:"endpoint"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	p := auth.PrincipalFrom(c)
	if _, err := s.d.Pool.Exec(c.Context(), `DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`,
		strings.TrimSpace(in.Endpoint), p.UserID); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

var testText = tr{"Уведомления о сбоях включены — так будет выглядеть сообщение.",
	"Outage notifications are on — this is what they look like.",
	"Ақау туралы хабарландырулар қосулы — хабар осылай көрінеді."}

// pushTest sends a test notification to the caller's browsers.
func (s *Service) pushTest(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	v, err := s.VAPID(c.Context())
	if err != nil {
		return err
	}
	rows, err := s.d.Pool.Query(c.Context(), `SELECT id, user_id, locale, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, p.UserID)
	if err != nil {
		return err
	}
	subs, err := pgx.CollectRows(rows, scanSub)
	if err != nil {
		return err
	}
	sent := 0
	for _, sub := range subs {
		payload, _ := jsonPayload("Cineko", testText.in(sub.locale))
		if s.push(c.Context(), v, sub, payload, "normal") {
			sent++
		}
	}
	return c.JSON(fiber.Map{"sent": sent, "failed": len(subs) - sent})
}

func jsonPayload(title, body string) ([]byte, error) {
	return json.Marshal(PushPayload{Title: title, Body: body, URL: incidentsURL, Tag: "cineko-test"})
}
