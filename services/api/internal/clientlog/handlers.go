package clientlog

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
)

// Routes mounts ingestion: any signed-in session, paired TV or read token.
func (s *Service) Routes(api fiber.Router) {
	api.Post("/client-errors", auth.RequireReader(), s.ingest)
}

// AdminRoutes mounts the admin views on the admin group (RequireAdmin).
func (s *Service) AdminRoutes(admin fiber.Router) {
	admin.Get("/client-errors", s.list)
	admin.Get("/client-errors/users", s.users)
	admin.Get("/client-errors/:id", s.get)
	admin.Patch("/client-errors/:id", s.update)
	admin.Delete("/client-errors/:id", s.remove)
}

type eventInput struct {
	App         string          `json:"app"`
	Kind        string          `json:"kind"`
	Message     string          `json:"message"`
	Stack       string          `json:"stack"`
	URL         string          `json:"url"`
	Component   string          `json:"component"`
	Release     string          `json:"release"`
	UserAgent   string          `json:"user_agent"`
	DeviceModel string          `json:"device_model"`
	ProfileID   string          `json:"profile_id"`
	Extra       json.RawMessage `json:"extra"`
	OccurredAt  *time.Time      `json:"occurred_at"`
	Count       int             `json:"count"`
}

func (s *Service) ingest(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	body := c.Body()
	if len(body) > MaxBatchBytes {
		return httpx.NewError(fiber.StatusRequestEntityTooLarge, "payload_too_large", "The batch is larger than 64 KB.")
	}
	// Decoded regardless of Content-Type: sendBeacon sends text/plain.
	var in struct {
		Events []eventInput `json:"events"`
	}
	if len(body) == 0 || json.Unmarshal(body, &in) != nil {
		return httpx.BadRequest("Malformed JSON body.")
	}
	if len(in.Events) == 0 || len(in.Events) > MaxBatchEvents {
		return httpx.Validation(map[string]string{"events": "must contain 1-20 events"})
	}
	for i, ev := range in.Events {
		f := "events[" + strconv.Itoa(i) + "]."
		switch {
		case ev.App != "web" && ev.App != "tv":
			return httpx.Validation(map[string]string{f + "app": "must be web or tv"})
		case !slices.Contains(Kinds, ev.Kind):
			return httpx.Validation(map[string]string{f + "kind": "unknown kind"})
		case ev.ProfileID != "" && !isUUID(ev.ProfileID):
			return httpx.Validation(map[string]string{f + "profile_id": "must be a UUID"})
		}
	}
	who := Who{UserID: p.UserID}
	key := "u:" + p.UserID
	if p.Kind == auth.KindDevice {
		who.DeviceID = p.DeviceID
		key = "d:" + p.DeviceID
	}
	now := s.now()
	accepted := 0
	for _, in := range in.Events {
		// Over budget: drop silently (still 202) so clients never retry.
		if !s.allow(key) {
			break
		}
		ev := Event{
			App: in.App, Kind: in.Kind, Message: in.Message, Stack: in.Stack, URL: in.URL,
			Component: in.Component, Release: in.Release, UserAgent: in.UserAgent,
			DeviceModel: in.DeviceModel, Extra: in.Extra, Count: in.Count, ProfileID: in.ProfileID,
		}
		if ev.UserAgent == "" {
			ev.UserAgent = c.Get(fiber.HeaderUserAgent)
		}
		if in.OccurredAt != nil {
			ev.OccurredAt = *in.OccurredAt
		}
		ev.sanitize(now)
		if err := s.record(c.Context(), ev, who); err != nil {
			return err
		}
		accepted++
	}
	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{"accepted": accepted})
}

// ---------------------------------------------------------------- 5xx hook

// WrapErrorHandler records the API's own 5xx responses (except 503, which
// means "not configured / temporarily unavailable") as app "api" after next
// has rendered them. Recording runs in the background with a bounded number
// of writes in flight and never affects the response.
func (s *Service) WrapErrorHandler(next fiber.ErrorHandler) fiber.ErrorHandler {
	return func(c fiber.Ctx, err error) error {
		out := next(c, err)
		status := c.Response().StatusCode()
		if status < 500 || status == fiber.StatusServiceUnavailable || strings.HasSuffix(c.Path(), "/client-errors") {
			return out
		}
		code, msg := "internal", err.Error()
		var apiErr *httpx.Error
		var fErr *fiber.Error
		switch {
		case errors.As(err, &apiErr):
			code, msg = apiErr.Code, apiErr.Message
		case errors.As(err, &fErr):
			code, msg = "http_"+strconv.Itoa(fErr.Code), fErr.Message
		}
		route := c.Path()
		if r := c.Route(); r != nil && r.Path != "" && r.Path != "/" && !strings.HasSuffix(r.Path, "*") {
			route = r.Path
		}
		ev := Event{
			App:       "api",
			Kind:      "api",
			Message:   strconv.Itoa(status) + " " + code + ": " + msg,
			URL:       strings.Clone(c.Path()),
			Component: c.Method() + " " + strings.Clone(route),
			Release:   s.version,
			UserAgent: strings.Clone(c.Get(fiber.HeaderUserAgent)),
			RequestID: httpx.RequestID(c),
			Extra:     mustJSON(map[string]any{"status": status, "code": code}),
		}
		var who Who
		if p := auth.PrincipalFrom(c); p != nil {
			who.UserID = p.UserID
			if p.Kind == auth.KindDevice {
				who.DeviceID = p.DeviceID
			}
		}
		if !s.allow("api") {
			return out
		}
		select {
		case s.inflight <- struct{}{}:
		default:
			return out // too many writes in flight: drop
		}
		go func() {
			defer func() { <-s.inflight }()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			ev.sanitize(s.now())
			if err := s.record(ctx, ev, who); err != nil {
				s.log.Warn("record api error failed", "err", err)
			}
		}()
		return out
	}
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func isUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil && len(s) == 36
}

// ---------------------------------------------------------------- admin

// Group is the admin view of an error group.
type Group struct {
	ID              string     `json:"id"`
	App             string     `json:"app"`
	Kind            string     `json:"kind"`
	Message         string     `json:"message"`
	TopFrame        string     `json:"top_frame"`
	Component       string     `json:"component"`
	Count           int64      `json:"count"`
	UsersAffected   int        `json:"users_affected"`
	DevicesAffected int        `json:"devices_affected"`
	FirstSeen       time.Time  `json:"first_seen"`
	LastSeen        time.Time  `json:"last_seen"`
	LastRelease     string     `json:"last_release"`
	LastURL         string     `json:"last_url"`
	Status          string     `json:"status"`
	ResolvedAt      *time.Time `json:"resolved_at"`
	Regressed       bool       `json:"regressed"`
}

const groupCols = `g.id, g.app, g.kind, g.message, g.top_frame, g.component, g.count,
	(SELECT count(*) FROM client_error_affected a WHERE a.group_id = g.id AND a.kind = 'u'),
	(SELECT count(*) FROM client_error_affected a WHERE a.group_id = g.id AND a.kind = 'd'),
	g.first_seen, g.last_seen, g.last_release, g.last_url, g.resolved_at, g.regressed_at`

// userGroupCols is groupCols as one user saw it (the `ua` affected row joined
// by userJoin): their own count and first/last seen, and their devices.
const userGroupCols = `g.id, g.app, g.kind, g.message, g.top_frame, g.component, ua.count, 1,
	(SELECT count(*) FROM client_error_affected a JOIN devices d ON d.id = a.subject_id
	 WHERE a.group_id = g.id AND a.kind = 'd' AND d.owner_user_id = ua.subject_id),
	ua.first_seen, ua.last_seen, g.last_release, g.last_url, g.resolved_at, g.regressed_at`

func userJoin(p string) string {
	return ` JOIN client_error_affected ua ON ua.group_id = g.id AND ua.kind = 'u' AND ua.subject_id = ` + p
}

func scanGroup(row pgx.Row) (Group, error) {
	var g Group
	var regressedAt *time.Time
	err := row.Scan(&g.ID, &g.App, &g.Kind, &g.Message, &g.TopFrame, &g.Component, &g.Count,
		&g.UsersAffected, &g.DevicesAffected, &g.FirstSeen, &g.LastSeen, &g.LastRelease, &g.LastURL,
		&g.ResolvedAt, &regressedAt)
	g.Status = "unresolved"
	if g.ResolvedAt != nil {
		g.Status = "resolved"
	}
	g.Regressed = regressedAt != nil && g.ResolvedAt == nil
	return g, err
}

func (s *Service) list(c fiber.Ctx) error {
	var where []string
	var args []any
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	bad := map[string]string{}
	// With user_id the groups are that user's: counts and times are theirs.
	cols, from, seen, count := groupCols, ` FROM client_error_groups g`, "g.last_seen", "g.count"
	if v := c.Query("user_id"); v != "" {
		if !isUUID(v) {
			bad["user_id"] = "must be a UUID"
		} else {
			cols, from, seen, count = userGroupCols, from+userJoin(arg(v)), "ua.last_seen", "ua.count"
		}
	}
	if v := c.Query("app"); v != "" {
		if !slices.Contains(Apps, v) {
			bad["app"] = "unknown app"
		}
		where = append(where, "g.app = "+arg(v))
	}
	if v := c.Query("kind"); v != "" {
		if !slices.Contains(Kinds, v) {
			bad["kind"] = "unknown kind"
		}
		where = append(where, "g.kind = "+arg(v))
	}
	switch c.Query("status", "unresolved") {
	case "unresolved":
		where = append(where, "g.resolved_at IS NULL")
	case "resolved":
		where = append(where, "g.resolved_at IS NOT NULL")
	case "all":
	default:
		bad["status"] = "must be unresolved, resolved or all"
	}
	if v := c.Query("since"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			bad["since"] = "must be an RFC 3339 time"
		}
		where = append(where, seen+" >= "+arg(t))
	}
	if v := c.Query("device_id"); v != "" {
		if !isUUID(v) {
			bad["device_id"] = "must be a UUID"
		} else {
			where = append(where, "EXISTS (SELECT 1 FROM client_error_affected a WHERE a.group_id = g.id AND a.kind = 'd' AND a.subject_id = "+arg(v)+")")
		}
	}
	if v := strings.TrimSpace(c.Query("q")); v != "" {
		if len(v) > 200 {
			bad["q"] = "too long"
		}
		esc := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(v)
		p := arg("%" + esc + "%")
		where = append(where, "(g.message ILIKE "+p+" OR g.component ILIKE "+p+" OR g.top_frame ILIKE "+p+")")
	}
	order := seen + " DESC, g.id"
	switch c.Query("sort", "last_seen") {
	case "last_seen":
	case "count":
		order = count + " DESC, " + seen + " DESC, g.id"
	default:
		bad["sort"] = "must be last_seen or count"
	}
	limit := fiber.Query[int](c, "limit", 50)
	offset := fiber.Query[int](c, "offset", 0)
	if limit < 1 || limit > 100 {
		bad["limit"] = "must be 1-100"
	}
	if offset < 0 {
		bad["offset"] = "must be >= 0"
	}
	if len(bad) > 0 {
		return httpx.Validation(bad)
	}
	cond := ""
	if len(where) > 0 {
		cond = " WHERE " + strings.Join(where, " AND ")
	}
	ctx := c.Context()
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*)`+from+cond, args...).Scan(&total); err != nil {
		return err
	}
	rows, err := s.pool.Query(ctx, `SELECT `+cols+from+cond+
		` ORDER BY `+order+` LIMIT `+arg(limit)+` OFFSET `+arg(offset), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []Group{}
	for rows.Next() {
		g, err := scanGroup(rows)
		if err != nil {
			return err
		}
		items = append(items, g)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"items": items, "total": total})
}

// group loads one group; with userID, as that user saw it (not found when
// they never hit it).
func (s *Service) group(ctx context.Context, id, userID string) (Group, error) {
	q, args := `SELECT `+groupCols+` FROM client_error_groups g WHERE g.id = $1`, []any{id}
	if userID != "" {
		q, args = `SELECT `+userGroupCols+` FROM client_error_groups g`+userJoin("$2")+` WHERE g.id = $1`, []any{id, userID}
	}
	g, err := scanGroup(s.pool.QueryRow(ctx, q, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return g, errNotFound
	}
	return g, err
}

// Sample is one stored occurrence.
type Sample struct {
	ID          int64           `json:"id"`
	OccurredAt  time.Time       `json:"occurred_at"`
	ReceivedAt  time.Time       `json:"received_at"`
	Count       int             `json:"count"`
	User        *SampleUser     `json:"user"`
	Device      *SampleDevice   `json:"device"`
	ProfileName *string         `json:"profile_name"`
	Message     string          `json:"message"`
	Stack       string          `json:"stack"`
	URL         string          `json:"url"`
	Component   string          `json:"component"`
	Release     string          `json:"release"`
	UserAgent   string          `json:"user_agent"`
	DeviceModel string          `json:"device_model"`
	Extra       json.RawMessage `json:"extra"`
	RequestID   string          `json:"request_id"`
}

type SampleUser struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

type SampleDevice struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (s *Service) get(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	userID := c.Query("user_id")
	if userID != "" && !isUUID(userID) {
		return httpx.Validation(map[string]string{"user_id": "must be a UUID"})
	}
	ctx := c.Context()
	g, err := s.group(ctx, id, userID)
	if errors.Is(err, errNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT s.id, s.occurred_at, s.received_at, s.count,
		       u.id, u.username, u.display_name, d.id, d.name, p.name,
		       s.message, s.stack, s.url, s.component, s.release, s.user_agent, s.device_model,
		       s.extra, s.request_id
		FROM client_error_samples s
		LEFT JOIN users u ON u.id = s.user_id
		LEFT JOIN devices d ON d.id = s.device_id
		LEFT JOIN profiles p ON p.id = s.profile_id
		WHERE s.group_id = $1 AND ($3::uuid IS NULL OR s.user_id = $3)
		ORDER BY s.id DESC
		LIMIT $2`, id, samplesPerGroup, nullable(userID))
	if err != nil {
		return err
	}
	defer rows.Close()
	samples := []Sample{}
	for rows.Next() {
		var sm Sample
		var uid, uname, udisp, did, dname *string
		var extra []byte
		if err := rows.Scan(&sm.ID, &sm.OccurredAt, &sm.ReceivedAt, &sm.Count, &uid, &uname, &udisp, &did, &dname,
			&sm.ProfileName, &sm.Message, &sm.Stack, &sm.URL, &sm.Component, &sm.Release, &sm.UserAgent,
			&sm.DeviceModel, &extra, &sm.RequestID); err != nil {
			return err
		}
		if uid != nil {
			sm.User = &SampleUser{ID: *uid, Username: *uname, DisplayName: *udisp}
		}
		if did != nil {
			sm.Device = &SampleDevice{ID: *did, Name: *dname}
		}
		if len(extra) > 0 {
			sm.Extra = extra
		} else {
			sm.Extra = json.RawMessage("null")
		}
		samples = append(samples, sm)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"group": g, "samples": samples})
}

func (s *Service) update(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	var in struct {
		Resolved *bool `json:"resolved"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if in.Resolved == nil {
		return httpx.Validation(map[string]string{"resolved": "is required"})
	}
	q := `UPDATE client_error_groups SET resolved_at = NULL, resolved_by = NULL WHERE id = $1`
	var by *string
	if *in.Resolved {
		q = `UPDATE client_error_groups
			SET resolved_at = coalesce(resolved_at, now()), resolved_by = $2, regressed_at = NULL WHERE id = $1`
		if p := auth.PrincipalFrom(c); p != nil {
			by = &p.UserID
		}
	}
	args := []any{id}
	if *in.Resolved {
		args = append(args, by)
	}
	cmd, err := s.pool.Exec(c.Context(), q, args...)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return httpx.NotFound()
	}
	g, err := s.group(c.Context(), id, "")
	if errors.Is(err, errNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	return c.JSON(g)
}

// ErrorUser is an account that hit at least one stored group (the filter list).
type ErrorUser struct {
	ID          string    `json:"id"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name"`
	Groups      int       `json:"groups"`
	LastSeen    time.Time `json:"last_seen"`
}

func (s *Service) users(c fiber.Ctx) error {
	rows, err := s.pool.Query(c.Context(), `
		SELECT u.id, u.username, u.display_name, count(*), max(a.last_seen)
		FROM client_error_affected a JOIN users u ON u.id = a.subject_id
		WHERE a.kind = 'u'
		GROUP BY u.id
		ORDER BY lower(coalesce(nullif(u.display_name, ''), u.username)), u.id`)
	if err != nil {
		return err
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (ErrorUser, error) {
		var u ErrorUser
		return u, r.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Groups, &u.LastSeen)
	})
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"items": items})
}

func (s *Service) remove(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	cmd, err := s.pool.Exec(c.Context(), `DELETE FROM client_error_groups WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return httpx.NotFound()
	}
	return c.SendStatus(fiber.StatusNoContent)
}
