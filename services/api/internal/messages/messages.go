// Package messages lets administrators send short messages to users. They
// are stored per recipient (inbox with read state) and delivered live over
// the realtime socket: to the recipients' browsers, and to the TVs they own
// when show_on_tv is set.
package messages

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/db"
	"martytv/api/internal/httpx"
	"martytv/api/internal/realtime"
)

const (
	maxTitle      = 80
	maxBody       = 1000
	maxRecipients = 1000
	inboxLimit    = 100
)

// Message is one inbox entry (also the realtime `message` event payload).
type Message struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	FromName  string     `json:"from_name"`
	CreatedAt time.Time  `json:"created_at"`
	ReadAt    *time.Time `json:"read_at"`
}

// SentMessage is the admin view of a sent message.
type SentMessage struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	Body       string    `json:"body"`
	CreatedAt  time.Time `json:"created_at"`
	Recipients int       `json:"recipients"`
	ReadCount  int       `json:"read_count"`
	ShowOnTV   bool      `json:"show_on_tv"`
}

// Notifier is the realtime hub.
type Notifier interface {
	NotifyUsers(userIDs []string, env realtime.Envelope)
	NotifyDevicesOwnedBy(userIDs []string, env realtime.Envelope)
}

type Handlers struct {
	pool  *pgxpool.Pool
	hub   Notifier
	audit *audit.Logger
	limit *httpx.RateLimiter
}

func NewHandlers(pool *pgxpool.Pool, hub Notifier, a *audit.Logger) *Handlers {
	return &Handlers{pool: pool, hub: hub, audit: a, limit: httpx.NewRateLimiter(20, time.Hour)}
}

// Routes mounts the caller's inbox.
func (h *Handlers) Routes(r fiber.Router) {
	r.Get("/messages", requireScoped(), h.inbox)
	r.Post("/messages/:id/read", requireScoped(), h.markRead)
}

// AdminRoutes mounts sending/listing on the admin group (RequireAdmin).
func (h *Handlers) AdminRoutes(admin fiber.Router) {
	admin.Get("/messages", h.sent)
	admin.Post("/messages", h.send)
}

// requireScoped: any principal; API tokens need read (GET) or write.
func requireScoped() fiber.Handler {
	return func(c fiber.Ctx) error {
		p := auth.PrincipalFrom(c)
		if p == nil {
			return httpx.Unauthorized()
		}
		if p.Kind == auth.KindToken {
			need := auth.ScopeWrite
			if c.Method() == fiber.MethodGet {
				need = auth.ScopeRead
			}
			if !p.HasScope(need) {
				return httpx.NewError(fiber.StatusForbidden, "insufficient_scope", "Token lacks the "+need+" scope.")
			}
		}
		return c.Next()
	}
}

type sendInput struct {
	Title    string   `json:"title"`
	Body     string   `json:"body"`
	UserIDs  []string `json:"user_ids"`
	ShowOnTV *bool    `json:"show_on_tv"`
}

func (h *Handlers) send(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	var in sendInput
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	in.Title, in.Body = strings.TrimSpace(in.Title), strings.TrimSpace(in.Body)
	f := map[string]string{}
	if n := utf8.RuneCountInString(in.Title); n < 1 || n > maxTitle {
		f["title"] = "must be 1-80 characters"
	}
	if n := utf8.RuneCountInString(in.Body); n < 1 || n > maxBody {
		f["body"] = "must be 1-1000 characters"
	}
	if len(in.UserIDs) > maxRecipients {
		f["user_ids"] = "too many recipients"
	}
	for _, id := range in.UserIDs {
		if _, err := uuid.Parse(id); err != nil || len(id) != 36 {
			f["user_ids"] = "must be user UUIDs"
			break
		}
	}
	if len(f) > 0 {
		return httpx.Validation(f)
	}
	showOnTV := in.ShowOnTV == nil || *in.ShowOnTV
	if ok, wait := h.limit.Allow(p.UserID); !ok {
		return httpx.TooManyRequests(wait)
	}
	ctx := c.Context()

	// Recipients: the given enabled users, or every enabled user but the sender.
	var recipients []string
	var err error
	if len(in.UserIDs) == 0 {
		recipients, err = collectIDs(ctx, h.pool, `SELECT id FROM users WHERE disabled_at IS NULL AND id <> $1`, p.UserID)
	} else {
		recipients, err = collectIDs(ctx, h.pool, `SELECT id FROM users WHERE disabled_at IS NULL AND id = ANY($1::uuid[])`, in.UserIDs)
		if err == nil && len(recipients) != len(uniq(in.UserIDs)) {
			return httpx.Validation(map[string]string{"user_ids": "unknown or disabled user"})
		}
	}
	if err != nil {
		return err
	}
	if len(recipients) == 0 {
		return httpx.Validation(map[string]string{"user_ids": "no recipients"})
	}

	var fromName string
	if err := h.pool.QueryRow(ctx, `SELECT COALESCE(NULLIF(display_name, ''), username) FROM users WHERE id = $1`,
		p.UserID).Scan(&fromName); err != nil {
		return err
	}
	msg := Message{Title: in.Title, Body: in.Body, FromName: fromName}
	err = pgx.BeginFunc(ctx, h.pool, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO messages (sender_user_id, sender_name, title, body, show_on_tv) VALUES ($1, $2, $3, $4, $5)
			RETURNING id, created_at`, p.UserID, fromName, in.Title, in.Body, showOnTV).Scan(&msg.ID, &msg.CreatedAt); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO message_recipients (message_id, user_id) SELECT $1, unnest($2::uuid[])`,
			msg.ID, recipients)
		return err
	})
	if err != nil {
		return err
	}
	h.audit.Record(ctx, audit.Event{UserID: p.UserID, Action: "admin.message_sent", TargetType: "message", TargetID: msg.ID,
		IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: map[string]any{"recipients": len(recipients), "show_on_tv": showOnTV}})

	payload, _ := json.Marshal(msg)
	env := realtime.Envelope{Type: realtime.TypeMessage, Payload: payload}
	h.hub.NotifyUsers(recipients, env)
	if showOnTV {
		h.hub.NotifyDevicesOwnedBy(recipients, env)
	}
	return c.Status(fiber.StatusCreated).JSON(SentMessage{ID: msg.ID, Title: msg.Title, Body: msg.Body,
		CreatedAt: msg.CreatedAt, Recipients: len(recipients), ShowOnTV: showOnTV})
}

func (h *Handlers) sent(c fiber.Ctx) error {
	rows, err := h.pool.Query(c.Context(), `
		SELECT m.id, m.title, m.body, m.created_at, m.show_on_tv,
		       (SELECT count(*) FROM message_recipients r WHERE r.message_id = m.id)::int,
		       (SELECT count(*) FROM message_recipients r WHERE r.message_id = m.id AND r.read_at IS NOT NULL)::int
		FROM messages m ORDER BY m.created_at DESC LIMIT 200`)
	if err != nil {
		return err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (SentMessage, error) {
		var m SentMessage
		err := r.Scan(&m.ID, &m.Title, &m.Body, &m.CreatedAt, &m.ShowOnTV, &m.Recipients, &m.ReadCount)
		return m, err
	})
	if err != nil {
		return err
	}
	return c.JSON(httpx.List(out))
}

// inbox: the caller's messages; for a TV, its owner's show_on_tv messages.
func (h *Handlers) inbox(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	tvOnly := p.Kind == auth.KindDevice
	rows, err := h.pool.Query(c.Context(), `
		SELECT m.id, m.title, m.body, m.sender_name, m.created_at, r.read_at
		FROM message_recipients r JOIN messages m ON m.id = r.message_id
		WHERE r.user_id = $1 AND (NOT $2 OR m.show_on_tv)
		ORDER BY m.created_at DESC LIMIT $3`, p.UserID, tvOnly, inboxLimit)
	if err != nil {
		return err
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Message, error) {
		var m Message
		err := r.Scan(&m.ID, &m.Title, &m.Body, &m.FromName, &m.CreatedAt, &m.ReadAt)
		return m, err
	})
	if err != nil {
		return err
	}
	var unread int
	if err := h.pool.QueryRow(c.Context(), `
		SELECT count(*) FROM message_recipients r JOIN messages m ON m.id = r.message_id
		WHERE r.user_id = $1 AND r.read_at IS NULL AND (NOT $2 OR m.show_on_tv)`, p.UserID, tvOnly).Scan(&unread); err != nil {
		return err
	}
	if items == nil {
		items = []Message{}
	}
	return c.JSON(fiber.Map{"items": items, "unread": unread})
}

// markRead: only a recipient (or a TV of the recipient, for show_on_tv messages).
func (h *Handlers) markRead(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	p := auth.PrincipalFrom(c)
	tag, err := h.pool.Exec(c.Context(), `
		UPDATE message_recipients r SET read_at = COALESCE(r.read_at, now())
		FROM messages m
		WHERE r.message_id = $1 AND r.user_id = $2 AND m.id = r.message_id AND (NOT $3 OR m.show_on_tv)`,
		id, p.UserID, p.Kind == auth.KindDevice)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound()
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func collectIDs(ctx context.Context, q db.Querier, sql string, args ...any) ([]string, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func uniq(ids []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, id := range ids {
		id = strings.ToLower(id)
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}
