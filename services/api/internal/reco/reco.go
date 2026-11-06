// Package reco implements recommendations between people («Посоветовать»):
// a user recommends a title to other users of the household with an
// optional note; recipients see them in their inbox («Вам посоветовали»),
// react (like / dislike / watched, optional reply) and the sender sees the
// reactions. Recipients are notified live over the realtime socket (their
// browsers and the TVs they own); the sender is notified of reactions.
//
// Privacy: nothing about anyone's watch history is exposed. A media summary
// is only annotated with `me` for the caller's own profile (?profile_id).
package reco

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/catalog"
	"martytv/api/internal/db"
	"martytv/api/internal/httpx"
	"martytv/api/internal/realtime"
)

const (
	maxNote       = 500
	maxReply      = 300
	maxRecipients = 20
	inboxLimit    = 100
	sentLimit     = 200
	defaultColor  = "#6366f1"
)

// Realtime event types.
const (
	// TypeRecommendation: a new (or re-sent) recommendation for the
	// recipient; payload Recommendation. Sent to the recipient's browsers and
	// the TVs they own.
	TypeRecommendation = "recommendation"
	// TypeReaction: the recipient reacted/replied; payload Recommendation.
	// Sent to the sender's browsers.
	TypeReaction = "recommendation.reaction"
)

// PersonRef identifies the sender or recipient.
type PersonRef struct {
	UserID string `json:"user_id"`
	Name   string `json:"name"`
	Color  string `json:"color"`
	Avatar string `json:"avatar"`
}

// Recommendation is the API shape (and the realtime payload).
type Recommendation struct {
	ID        string               `json:"id"`
	Media     catalog.MediaSummary `json:"media"`
	From      PersonRef            `json:"from"`
	To        PersonRef            `json:"to"`
	Note      string               `json:"note"`
	CreatedAt time.Time            `json:"created_at"`
	SeenAt    *time.Time           `json:"seen_at"`
	Reaction  *string              `json:"reaction"`
	Reply     *string              `json:"reply"`

	mediaID string
}

// Notifier is the realtime hub.
type Notifier interface {
	NotifyUsers(userIDs []string, env realtime.Envelope)
	NotifyDevicesOwnedBy(userIDs []string, env realtime.Envelope)
}

// Summaries is the catalog service (stored titles as MediaSummary).
type Summaries interface {
	SummariesByID(ctx context.Context, ids []string, lang string) (map[string]catalog.MediaSummary, error)
}

type Handlers struct {
	pool     *pgxpool.Pool
	catalog  Summaries
	personal catalog.Personalizer
	hub      Notifier
	audit    *audit.Logger
	limit    *httpx.RateLimiter
}

func NewHandlers(pool *pgxpool.Pool, cat Summaries, personal catalog.Personalizer, hub Notifier, a *audit.Logger) *Handlers {
	return &Handlers{pool: pool, catalog: cat, personal: personal, hub: hub, audit: a,
		limit: httpx.NewRateLimiter(60, time.Hour)}
}

// Routes mounts /recommendations. The inbox is readable by TVs (their
// owner's inbox); everything else needs a user (session or token).
func (h *Handlers) Routes(r fiber.Router) {
	r.Post("/recommendations", auth.RequireUser(), h.create)
	r.Get("/recommendations/inbox", auth.RequireReader(), h.inbox)
	r.Get("/recommendations/sent", auth.RequireUser(), h.sent)
	r.Patch("/recommendations/:id", auth.RequireUser(), h.update)
	r.Delete("/recommendations/:id", auth.RequireUser(), h.remove)
}

// ---- params ----

func langParam(c fiber.Ctx) (string, error) {
	switch l := c.Query("lang"); l {
	case "", "en":
		return "en", nil
	case "ru":
		return "ru", nil
	}
	return "", httpx.Validation(map[string]string{"lang": "must be one of en, ru"})
}

// profileParam validates ?profile_id (must be usable by the caller); "" when absent.
func (h *Handlers) profileParam(c fiber.Ctx) (string, error) {
	pid := c.Query("profile_id")
	if pid == "" {
		return "", nil
	}
	if !isUUID(pid) {
		return "", httpx.Validation(map[string]string{"profile_id": "must be a UUID"})
	}
	pid = strings.Clone(pid)
	if _, err := h.personal.Viewer(c, pid); err != nil {
		return "", err
	}
	return pid, nil
}

func isUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil && len(s) == 36
}

// ---- create ----

type createInput struct {
	MediaID       string   `json:"media_id"`
	ToUserIDs     []string `json:"to_user_ids"`
	Note          string   `json:"note"`
	FromProfileID *string  `json:"from_profile_id"`
}

func (h *Handlers) create(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	var in createInput
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	lang, err := langParam(c)
	if err != nil {
		return err
	}
	in.Note = strings.TrimSpace(in.Note)
	f := map[string]string{}
	if !isUUID(in.MediaID) {
		f["media_id"] = "must be a UUID"
	}
	recipients := uniq(in.ToUserIDs)
	switch {
	case len(recipients) < 1:
		f["to_user_ids"] = "at least one recipient"
	case len(recipients) > maxRecipients:
		f["to_user_ids"] = "at most 20 recipients"
	}
	for _, id := range recipients {
		if !isUUID(id) {
			f["to_user_ids"] = "must be user UUIDs"
			break
		}
	}
	if utf8.RuneCountInString(in.Note) > maxNote {
		f["note"] = "must be at most 500 characters"
	}
	if in.FromProfileID != nil && *in.FromProfileID != "" && !isUUID(*in.FromProfileID) {
		f["from_profile_id"] = "must be a UUID"
	}
	if len(f) > 0 {
		return httpx.Validation(f)
	}
	if ok, wait := h.limit.Allow(p.UserID); !ok {
		return httpx.TooManyRequests(wait)
	}
	ctx := c.Context()

	// Recipients: enabled users other than the sender. Unknown, disabled and
	// self get the same answer.
	var n int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = ANY($1::uuid[]) AND disabled_at IS NULL AND id <> $2`,
		recipients, p.UserID).Scan(&n); err != nil {
		return err
	}
	if n != len(recipients) {
		return httpx.Validation(map[string]string{"to_user_ids": "unknown or disabled user"})
	}
	var fromProfile *string
	if in.FromProfileID != nil && *in.FromProfileID != "" {
		var ok bool
		if err := h.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2)`,
			*in.FromProfileID, p.UserID).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return httpx.Validation(map[string]string{"from_profile_id": "not one of your profiles"})
		}
		fromProfile = in.FromProfileID
	}
	var exists bool
	if err := h.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM media WHERE id = $1)`, in.MediaID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return httpx.NotFound()
	}

	ids := make([]string, 0, len(recipients))
	deduped := 0
	err = pgx.BeginFunc(ctx, h.pool, func(tx pgx.Tx) error {
		for _, to := range recipients {
			// Same sender, recipient and title within 7 days: update it
			// (and bring it back if the recipient had dismissed it).
			var id string
			err := tx.QueryRow(ctx, `
				UPDATE recommendations SET
				  seen_at = CASE WHEN note = $5 AND NOT deleted_by_recipient THEN seen_at END,
				  deleted_by_recipient = false,
				  note = $5, from_profile_id = $4
				WHERE id = (SELECT id FROM recommendations
				            WHERE from_user_id = $1 AND to_user_id = $2 AND media_id = $3
				              AND created_at > now() - interval '7 days'
				            ORDER BY created_at DESC LIMIT 1 FOR UPDATE)
				RETURNING id`, p.UserID, to, in.MediaID, fromProfile, in.Note).Scan(&id)
			if err == nil {
				deduped++
				ids = append(ids, id)
				continue
			}
			if !db.IsNoRows(err) {
				return err
			}
			if err := tx.QueryRow(ctx, `
				INSERT INTO recommendations (media_id, from_user_id, from_profile_id, to_user_id, note)
				VALUES ($1, $2, $3, $4, $5) RETURNING id`, in.MediaID, p.UserID, fromProfile, to, in.Note).Scan(&id); err != nil {
				return err
			}
			ids = append(ids, id)
		}
		return nil
	})
	if err != nil {
		return err
	}
	h.audit.Record(ctx, audit.Event{UserID: p.UserID, Action: "reco.sent", TargetType: "media", TargetID: in.MediaID,
		IP: c.IP(), RequestID: httpx.RequestID(c),
		Metadata: map[string]any{"recipients": len(recipients), "updated": deduped, "note": in.Note != ""}})

	items, err := h.load(ctx, `r.id = ANY($1::uuid[])`, []any{ids}, lang, "", "r.created_at DESC", len(ids))
	if err != nil {
		return err
	}
	for _, it := range items {
		h.notify(TypeRecommendation, it, it.To.UserID, true)
	}
	return c.Status(fiber.StatusCreated).JSON(httpx.List(items))
}

func (h *Handlers) notify(typ string, it Recommendation, userID string, devices bool) {
	payload, err := json.Marshal(it)
	if err != nil {
		return
	}
	env := realtime.Envelope{Type: typ, Payload: payload}
	h.hub.NotifyUsers([]string{userID}, env)
	if devices {
		h.hub.NotifyDevicesOwnedBy([]string{userID}, env)
	}
}

// ---- lists ----

// inbox: received by the caller (a TV reads its owner's), newest first.
func (h *Handlers) inbox(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	lang, err := langParam(c)
	if err != nil {
		return err
	}
	pid, err := h.profileParam(c)
	if err != nil {
		return err
	}
	items, err := h.load(c.Context(), `r.to_user_id = $1 AND NOT r.deleted_by_recipient`, []any{p.UserID},
		lang, pid, "r.created_at DESC, r.id", inboxLimit)
	if err != nil {
		return err
	}
	var unseen int
	if err := h.pool.QueryRow(c.Context(), `
		SELECT count(*) FROM recommendations WHERE to_user_id = $1 AND NOT deleted_by_recipient AND seen_at IS NULL`,
		p.UserID).Scan(&unseen); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"items": items, "unseen": unseen})
}

// sent: by the caller, with the recipients' reactions (also dismissed ones).
func (h *Handlers) sent(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	lang, err := langParam(c)
	if err != nil {
		return err
	}
	items, err := h.load(c.Context(), `r.from_user_id = $1`, []any{p.UserID}, lang, "",
		"COALESCE(r.reacted_at, r.created_at) DESC, r.id", sentLimit)
	if err != nil {
		return err
	}
	return c.JSON(httpx.List(items))
}

// ---- update / delete ----

func (h *Handlers) update(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	lang, err := langParam(c)
	if err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	if err := httpx.BindJSON(c, &raw); err != nil {
		return err
	}
	var (
		f                     = map[string]string{}
		setSeen, seen         bool
		setReaction, setReply bool
		reaction, reply       *string
	)
	if v, ok := raw["seen"]; ok {
		setSeen = true
		if json.Unmarshal(v, &seen) != nil {
			f["seen"] = "must be a boolean"
		}
	}
	if v, ok := raw["reaction"]; ok {
		setReaction = true
		if json.Unmarshal(v, &reaction) != nil || (reaction != nil &&
			*reaction != "like" && *reaction != "dislike" && *reaction != "watched") {
			f["reaction"] = "must be like, dislike, watched or null"
		}
	}
	if v, ok := raw["reply"]; ok {
		setReply = true
		if json.Unmarshal(v, &reply) != nil {
			f["reply"] = "must be a string or null"
		} else if reply != nil {
			t := strings.TrimSpace(*reply)
			if utf8.RuneCountInString(t) > maxReply {
				f["reply"] = "must be at most 300 characters"
			}
			if t == "" {
				reply = nil
			} else {
				reply = &t
			}
		}
	}
	if len(f) > 0 {
		return httpx.Validation(f)
	}
	ctx := c.Context()
	// Reacting or replying implies seen.
	var fromUser string
	err = h.pool.QueryRow(ctx, `
		UPDATE recommendations SET
		  seen_at = CASE WHEN $3 OR $5 OR $7 THEN COALESCE(seen_at, now())
		                 WHEN $8 THEN NULL ELSE seen_at END,
		  reaction = CASE WHEN $5 THEN $4 ELSE reaction END,
		  reply = CASE WHEN $7 THEN $6 ELSE reply END,
		  reacted_at = CASE WHEN $5 OR $7 THEN now() ELSE reacted_at END
		WHERE id = $1 AND to_user_id = $2 AND NOT deleted_by_recipient
		RETURNING from_user_id`,
		id, p.UserID, setSeen && seen, reaction, setReaction, reply, setReply, setSeen && !seen).Scan(&fromUser)
	if db.IsNoRows(err) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	items, err := h.load(ctx, `r.id = $1`, []any{id}, lang, "", "r.id", 1)
	if err != nil {
		return err
	}
	if len(items) == 0 {
		return httpx.NotFound()
	}
	if setReaction || setReply {
		h.notify(TypeReaction, items[0], fromUser, false)
	}
	return c.JSON(items[0])
}

// remove: the recipient dismisses (the sender keeps seeing it in /sent);
// the sender withdraws it entirely.
func (h *Handlers) remove(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	ctx := c.Context()
	tag, err := h.pool.Exec(ctx, `UPDATE recommendations SET deleted_by_recipient = true WHERE id = $1 AND to_user_id = $2`, id, p.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		if tag, err = h.pool.Exec(ctx, `DELETE FROM recommendations WHERE id = $1 AND from_user_id = $2`, id, p.UserID); err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return httpx.NotFound()
		}
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// ---- loading ----

// load reads recommendations matching where (args start at $1) with their
// people and media summaries in lang; with profileID, summaries carry that
// profile's `me`. orderBy and limit are constants from this file.
func (h *Handlers) load(ctx context.Context, where string, args []any, lang, profileID, orderBy string, limit int) ([]Recommendation, error) {
	rows, err := h.pool.Query(ctx, `
		SELECT r.id, r.media_id, r.note, r.created_at, r.seen_at, r.reaction, r.reply,
		       fu.id, COALESCE(fp.name, NULLIF(fu.display_name, ''), fu.username),
		       COALESCE(fp.color, fd.color, '`+defaultColor+`'), COALESCE(fp.avatar, fd.avatar, ''),
		       tu.id, COALESCE(NULLIF(tu.display_name, ''), tu.username),
		       COALESCE(td.color, '`+defaultColor+`'), COALESCE(td.avatar, '')
		FROM recommendations r
		JOIN users fu ON fu.id = r.from_user_id
		JOIN users tu ON tu.id = r.to_user_id
		LEFT JOIN profiles fp ON fp.id = r.from_profile_id
		LEFT JOIN LATERAL (SELECT color, avatar FROM profiles WHERE user_id = fu.id ORDER BY created_at, id LIMIT 1) fd ON true
		LEFT JOIN LATERAL (SELECT color, avatar FROM profiles WHERE user_id = tu.id ORDER BY created_at, id LIMIT 1) td ON true
		WHERE `+where+`
		ORDER BY `+orderBy+` LIMIT `+strconv.Itoa(limit), args...)
	if err != nil {
		return nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Recommendation, error) {
		var r Recommendation
		err := row.Scan(&r.ID, &r.mediaID, &r.Note, &r.CreatedAt, &r.SeenAt, &r.Reaction, &r.Reply,
			&r.From.UserID, &r.From.Name, &r.From.Color, &r.From.Avatar,
			&r.To.UserID, &r.To.Name, &r.To.Color, &r.To.Avatar)
		return r, err
	})
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(items))
	for _, it := range items {
		ids = append(ids, it.mediaID)
	}
	media, err := h.catalog.SummariesByID(ctx, ids, lang)
	if err != nil {
		return nil, err
	}
	var states map[string]catalog.MediaUserState
	if profileID != "" && len(ids) > 0 {
		if states, err = h.personal.UserStates(ctx, profileID, ids); err != nil {
			return nil, err
		}
	}
	out := make([]Recommendation, 0, len(items))
	for _, it := range items {
		m, ok := media[it.mediaID]
		if !ok {
			continue
		}
		if states != nil {
			st := states[it.mediaID]
			m.Me = &st
		}
		it.Media = m
		out = append(out, it)
	}
	return out, nil
}

func uniq(ids []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, id := range ids {
		id = strings.ToLower(strings.TrimSpace(id))
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}
