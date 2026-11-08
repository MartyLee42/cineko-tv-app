package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/integrations"
	"martytv/api/internal/messages"
	"martytv/api/internal/realtime"
	"martytv/api/internal/sysmon"
)

// Notifier is the realtime hub (live inbox delivery).
type Notifier interface {
	NotifyUsers(userIDs []string, env realtime.Envelope)
}

// Deps wires the monitor to the checks the API already runs.
type Deps struct {
	Pool *pgxpool.Pool
	Hub  Notifier
	// Checks: the cached integration checker (30 s TTL; /readyz shares it).
	Checks func(context.Context) []integrations.Status
	// Video: the last Invidious probe (video.Service.Health; no network).
	Video func() (configured bool, reachable *bool, latency time.Duration)
	// Disks: sysmon.Service.Disks.
	Disks func(context.Context) []sysmon.Disk
	// ProxyURL: the outbound proxy (TMDB_PROXY_URL, usually the VPN);
	// nil = no proxy check.
	ProxyURL *url.URL
	// Token authenticates the host scripts (ALERT_TOKEN); empty = the
	// internal endpoint answers 404.
	Token string
	// Location renders "с 21:30" in the household's timezone.
	Location *time.Location
	// PushSubject: the VAPID "sub" claim (the server's https URL or a mailto:).
	PushSubject string
	PushHTTP    *http.Client
	Log         *slog.Logger
}

// Service runs the monitor, stores incidents and notifies admins.
type Service struct {
	d      Deps
	mu     sync.Mutex // guards m, recent, cache
	m      *Machine
	recent map[string]time.Time // one-off events already announced (dedupe)
	cache  recipientsCache
	pusher *Pusher
	vapid  *VAPID
	vmu    sync.Mutex
	wg     sync.WaitGroup
	now    func() time.Time
}

type recipient struct {
	userID string
	locale string
}

// recipientsCache: the last admins and push subscriptions read, so a
// database outage can still be announced by push.
type recipientsCache struct {
	admins []recipient
	subs   []storedSub
}

type storedSub struct {
	id, userID, locale string
	sub                Subscription
}

func New(d Deps) *Service {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Location == nil {
		d.Location = time.UTC
	}
	if d.PushSubject == "" {
		d.PushSubject = "mailto:cineko@localhost"
	}
	client := d.PushHTTP
	if client == nil {
		// Direct (not via the VPN proxy): «VPN недоступен» must still go out.
		client = &http.Client{Timeout: 15 * time.Second}
	}
	return &Service{d: d, m: NewMachine(), recent: map[string]time.Time{},
		pusher: &Pusher{HTTP: client, Subject: d.PushSubject}, now: time.Now}
}

// Wait blocks until queued notifications are sent (tests, shutdown).
func (s *Service) Wait() { s.wg.Wait() }

// Run restores open incidents, then checks once a minute.
func (s *Service) Run(ctx context.Context) {
	s.restore(ctx)
	if _, err := s.VAPID(ctx); err != nil { // cached: push still works while the DB is down
		s.d.Log.Warn("alerts: VAPID key", "err", err)
	}
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.CheckOnce(ctx)
		}
	}
}

func (s *Service) restore(ctx context.Context) {
	if s.d.Pool == nil {
		return
	}
	rows, err := s.d.Pool.Query(ctx, `SELECT id, kind, cause, detail, source, notes, opened_at, last_notified_at
		FROM incidents WHERE closed_at IS NULL`)
	if err != nil {
		s.d.Log.Warn("alerts: restoring open incidents failed", "err", err)
		return
	}
	defer rows.Close()
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for rows.Next() {
		var id, kind, cause, detail, source string
		var notes []string
		var opened, notified time.Time
		if err := rows.Scan(&id, &kind, &cause, &detail, &source, &notes, &opened, &notified); err != nil {
			return
		}
		s.m.Restore(kind, id, cause, detail, source, notes, opened, notified, now)
	}
}

// CheckOnce runs the monitor's checks and announces what changed.
func (s *Service) CheckOnce(ctx context.Context) {
	obs := s.observe(ctx)
	now := s.now()
	s.mu.Lock()
	var events []Event
	for _, o := range obs {
		if e, ok := s.m.Observe(now, o); ok {
			events = append(events, e)
		}
	}
	events = append(events, s.m.Tick(now)...)
	s.mu.Unlock()
	for _, e := range events {
		s.handle(ctx, e)
	}
}

// diskLow: free space under min(10 % of the disk, 5 GiB).
func diskLow(d sysmon.Disk) bool {
	if d.Total == 0 {
		return false
	}
	limit := min(d.Total/10, 5<<30)
	return d.Free < limit
}

func (s *Service) observe(ctx context.Context) []Observation {
	var out []Observation
	add := func(kind string, ok bool, cause, detail string) {
		out = append(out, Observation{Kind: kind, OK: ok, Cause: cause, Detail: clip(detail, 200), Source: SourceMonitor})
	}
	proxyDown := false
	if u := s.d.ProxyURL; u != nil {
		host := u.Host
		if u.Port() == "" {
			port := "1080"
			if u.Scheme == "http" {
				port = "80"
			} else if u.Scheme == "https" {
				port = "443"
			}
			host = net.JoinHostPort(u.Hostname(), port)
		}
		conn, err := (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", host)
		if err == nil {
			conn.Close()
		}
		proxyDown = err != nil
		add(KindProxy, err == nil, "", "")
	}
	if s.d.Checks != nil {
		for _, st := range s.d.Checks(ctx) {
			kind := ""
			switch st.Name {
			case "tmdb":
				kind = KindTMDB
			case "prowlarr":
				kind = KindProwlarr
			case "jackett":
				kind = KindJackett
			case "torrserver":
				kind = KindTorrServer
			}
			// TMDB goes through the proxy: its outage is the VPN incident.
			if kind == "" || !st.Configured || (kind == KindTMDB && proxyDown) {
				continue
			}
			cause := ""
			if kind == KindTMDB && strings.Contains(st.Error, "HTTP 401") {
				cause = "unauthorized"
			}
			add(kind, st.OK, cause, st.Error)
		}
	}
	if s.d.Video != nil {
		if configured, reachable, _ := s.d.Video(); configured && reachable != nil {
			add(KindInvidious, *reachable, "", "")
		}
	}
	if s.d.Disks != nil {
		ok, detail := true, ""
		for _, d := range s.d.Disks(ctx) {
			if diskLow(d) {
				ok = false
				detail = fmt.Sprintf("%s %.1f GB", d.Mount, float64(d.Free)/1e9)
				break
			}
		}
		add(KindDisk, ok, "", detail)
	}
	if s.d.Pool != nil {
		pctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		err := s.d.Pool.Ping(pctx)
		cancel()
		add(KindDatabase, err == nil, "", "")
	}
	return out
}

// HostReport is POST /internal/incident.
type HostReport struct {
	Kind   string `json:"kind"`
	State  string `json:"state"` // down | up | event
	Cause  string `json:"cause"`
	Action string `json:"action"`
	Detail string `json:"detail"`
}

// ErrBadReport: validation failed (400).
var ErrBadReport = errors.New("bad report")

func (r *HostReport) validate() error {
	r.Detail = clip(sanitizeText(r.Detail), 120)
	switch r.Kind {
	case KindYouTube, KindVPN:
		if r.State != "down" && r.State != "up" && r.State != "event" {
			return ErrBadReport
		}
		if r.State == "event" && r.Action == "" {
			return ErrBadReport
		}
	case KindUpdater:
		if r.State != "event" || r.Cause == "" {
			return ErrBadReport
		}
	default:
		return ErrBadReport
	}
	if !ValidCause(r.Kind, r.Cause) || (r.Action != "" && !ValidAction(r.Action)) {
		return ErrBadReport
	}
	return nil
}

const eventDedupe = 6 * time.Hour

// Report applies a host script's report.
func (s *Service) Report(ctx context.Context, r HostReport) error {
	if err := r.validate(); err != nil {
		return err
	}
	now := s.now()
	var events []Event
	s.mu.Lock()
	switch {
	case r.Kind == KindUpdater:
		key := r.Kind + "/" + r.Cause + "/" + r.Detail
		if at, ok := s.recent[key]; !ok || now.Sub(at) >= eventDedupe {
			s.recent[key] = now
			events = append(events, Event{Type: EventOpened, Kind: r.Kind, Cause: r.Cause, Detail: r.Detail,
				Source: SourceHost, OpenedAt: now, At: now})
		}
	case r.State == "event":
		if e, ok := s.m.Note(now, r.Kind, r.Action); ok {
			events = append(events, e)
		}
	default:
		o := Observation{Kind: r.Kind, OK: r.State == "up", Cause: r.Cause, Detail: r.Detail, Source: SourceHost, Confirmed: true}
		if r.Action != "" && !o.OK {
			o.Actions = []string{r.Action}
		}
		if e, ok := s.m.Observe(now, o); ok {
			events = append(events, e)
		}
	}
	s.mu.Unlock()
	for _, e := range events {
		s.handle(ctx, e)
	}
	return nil
}

// handle persists an event and queues its notice.
func (s *Service) handle(ctx context.Context, e Event) {
	if s.d.Pool != nil {
		if err := s.persist(ctx, &e); err != nil {
			s.d.Log.Warn("alerts: storing incident failed", "kind", e.Kind, "err", err)
		}
	}
	level := slog.LevelInfo
	if e.Type == EventOpened || e.Type == EventReminder {
		level = slog.LevelWarn
	}
	s.d.Log.Log(ctx, level, "alerts: incident", "kind", e.Kind, "cause", e.Cause, "event", e.Type, "detail", e.Detail)
	switch e.Type {
	case EventOpened, EventRecovered, EventReminder:
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			nctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
			defer cancel()
			s.notify(nctx, e)
		}()
	}
}

func (s *Service) persist(ctx context.Context, e *Event) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	p := s.d.Pool
	notes := append([]string{}, e.Notes...)
	switch e.Type {
	case EventOpened:
		if e.Kind == KindUpdater { // one-off: open and closed at once
			_, err := p.Exec(ctx, `INSERT INTO incidents (kind, cause, detail, source, opened_at, closed_at, last_notified_at)
				VALUES ($1, $2, $3, $4, $5, $5, $5)`, e.Kind, e.Cause, e.Detail, e.Source, e.At)
			return err
		}
		if _, err := p.Exec(ctx, `UPDATE incidents SET closed_at = $2, silent_close = true WHERE kind = $1 AND closed_at IS NULL`,
			e.Kind, e.At); err != nil {
			return err
		}
		var id string
		if err := p.QueryRow(ctx, `INSERT INTO incidents (kind, cause, detail, source, notes, opened_at, last_notified_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, e.Kind, e.Cause, e.Detail, e.Source, notes, e.OpenedAt, e.At).Scan(&id); err != nil {
			return err
		}
		e.ID = id
		s.mu.Lock()
		s.m.SetID(e.Kind, id)
		s.mu.Unlock()
		return nil
	case EventRecovered, EventClosedSilently:
		silent := e.Type == EventClosedSilently
		if e.ID == "" { // opened while the DB was down (or the insert failed)
			_, err := p.Exec(ctx, `INSERT INTO incidents (kind, cause, detail, source, notes, opened_at, closed_at, silent_close, last_notified_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7)`, e.Kind, e.Cause, e.Detail, e.Source, notes, e.OpenedAt, e.At, silent)
			return err
		}
		_, err := p.Exec(ctx, `UPDATE incidents SET closed_at = $2, silent_close = $3 WHERE id = $1 AND closed_at IS NULL`, e.ID, e.At, silent)
		return err
	case EventReminder:
		if e.ID == "" {
			return nil
		}
		_, err := p.Exec(ctx, `UPDATE incidents SET last_notified_at = $2, reminders = reminders + 1 WHERE id = $1`, e.ID, e.At)
		return err
	case EventUpdated:
		if e.ID == "" {
			return nil
		}
		_, err := p.Exec(ctx, `UPDATE incidents SET cause = $2, detail = $3, notes = $4 WHERE id = $1`, e.ID, e.Cause, e.Detail, notes)
		return err
	}
	return nil
}

// PushPayload is what the PWA service worker shows.
type PushPayload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag"`
}

const incidentsURL = "/admin?tab=incidents"

// notify: a Cineko message to every admin (grouped by language) and a Web
// Push to their subscribed browsers.
func (s *Service) notify(ctx context.Context, e Event) {
	admins, subs := s.recipients(ctx)
	byLocale := map[string][]string{}
	for _, a := range admins {
		byLocale[a.locale] = append(byLocale[a.locale], a.userID)
	}
	for _, l := range Locales {
		ids := byLocale[l]
		if len(ids) == 0 {
			continue
		}
		if err := s.sendMessage(ctx, Render(e, l, s.d.Location), ids); err != nil {
			s.d.Log.Warn("alerts: inbox message failed", "kind", e.Kind, "err", err)
		}
	}
	if len(subs) == 0 {
		return
	}
	v, err := s.VAPID(ctx)
	if err != nil {
		s.d.Log.Warn("alerts: no VAPID key", "err", err)
		return
	}
	urgency := "high"
	if e.Type == EventRecovered {
		urgency = "normal"
	}
	for _, sub := range subs {
		t := Render(e, sub.locale, s.d.Location)
		payload, _ := json.Marshal(PushPayload{Title: t.Title, Body: t.Body, URL: incidentsURL, Tag: "cineko-incident-" + e.Kind})
		s.push(ctx, v, sub, payload, urgency)
	}
}

func (s *Service) push(ctx context.Context, v *VAPID, sub storedSub, payload []byte, urgency string) bool {
	err := s.pusher.Send(ctx, v, sub.sub, payload, urgency)
	if s.d.Pool == nil {
		return err == nil
	}
	switch {
	case errors.Is(err, ErrGone):
		_, _ = s.d.Pool.Exec(ctx, `DELETE FROM push_subscriptions WHERE id = $1`, sub.id)
	case err != nil:
		s.d.Log.Info("alerts: push failed", "err", err)
		_, _ = s.d.Pool.Exec(ctx, `UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1`, sub.id)
	default:
		_, _ = s.d.Pool.Exec(ctx, `UPDATE push_subscriptions SET failures = 0, last_ok_at = now() WHERE id = $1`, sub.id)
	}
	return err == nil
}

// recipients: enabled admins and super_admins with their alert language
// (their newest push subscription's, else Russian), and their push
// subscriptions. Falls back to the last good read when the DB is down.
func (s *Service) recipients(ctx context.Context) ([]recipient, []storedSub) {
	if s.d.Pool == nil {
		return nil, nil
	}
	admins, subs, err := s.loadRecipients(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		return s.cache.admins, s.cache.subs
	}
	s.cache = recipientsCache{admins: admins, subs: subs}
	return admins, subs
}

func (s *Service) loadRecipients(ctx context.Context) ([]recipient, []storedSub, error) {
	rows, err := s.d.Pool.Query(ctx, `
		SELECT u.id, COALESCE((SELECT ps.locale FROM push_subscriptions ps WHERE ps.user_id = u.id
		                       ORDER BY ps.created_at DESC LIMIT 1), 'ru')
		FROM users u WHERE u.role IN ('admin', 'super_admin') AND u.disabled_at IS NULL`)
	if err != nil {
		return nil, nil, err
	}
	admins, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (recipient, error) {
		var a recipient
		err := r.Scan(&a.userID, &a.locale)
		return a, err
	})
	if err != nil {
		return nil, nil, err
	}
	rows, err = s.d.Pool.Query(ctx, `
		SELECT ps.id, ps.user_id, ps.locale, ps.endpoint, ps.p256dh, ps.auth
		FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id
		WHERE u.role IN ('admin', 'super_admin') AND u.disabled_at IS NULL`)
	if err != nil {
		return nil, nil, err
	}
	subs, err := pgx.CollectRows(rows, scanSub)
	return admins, subs, err
}

func scanSub(r pgx.CollectableRow) (storedSub, error) {
	var x storedSub
	err := r.Scan(&x.id, &x.userID, &x.locale, &x.sub.Endpoint, &x.sub.P256dh, &x.sub.Auth)
	return x, err
}

func (s *Service) sendMessage(ctx context.Context, t Text, userIDs []string) error {
	msg := messages.Message{Title: clip(t.Title, 80), Body: clip(t.Body, 1000), FromName: "Cineko"}
	err := pgx.BeginFunc(ctx, s.d.Pool, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `INSERT INTO messages (sender_user_id, sender_name, title, body, show_on_tv)
			VALUES (NULL, $1, $2, $3, false) RETURNING id, created_at`, msg.FromName, msg.Title, msg.Body).Scan(&msg.ID, &msg.CreatedAt); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO message_recipients (message_id, user_id) SELECT $1, unnest($2::uuid[])`, msg.ID, userIDs)
		return err
	})
	if err != nil {
		return err
	}
	if s.d.Hub != nil {
		payload, _ := json.Marshal(msg)
		s.d.Hub.NotifyUsers(userIDs, realtime.Envelope{Type: realtime.TypeMessage, Payload: payload})
	}
	return nil
}

// VAPID returns the server's key pair, generating it on first use.
func (s *Service) VAPID(ctx context.Context) (*VAPID, error) {
	s.vmu.Lock()
	defer s.vmu.Unlock()
	if s.vapid != nil {
		return s.vapid, nil
	}
	if s.d.Pool == nil {
		return nil, errors.New("no database")
	}
	var priv string
	err := s.d.Pool.QueryRow(ctx, `SELECT private_key FROM push_vapid_keys WHERE id = 1`).Scan(&priv)
	if errors.Is(err, pgx.ErrNoRows) {
		v, gerr := NewVAPID()
		if gerr != nil {
			return nil, gerr
		}
		if _, err = s.d.Pool.Exec(ctx, `INSERT INTO push_vapid_keys (id, private_key, public_key) VALUES (1, $1, $2)
			ON CONFLICT (id) DO NOTHING`, v.PrivateString(), v.Public); err != nil {
			return nil, err
		}
		err = s.d.Pool.QueryRow(ctx, `SELECT private_key FROM push_vapid_keys WHERE id = 1`).Scan(&priv)
	}
	if err != nil {
		return nil, err
	}
	v, err := ParseVAPID(priv)
	if err != nil {
		return nil, err
	}
	s.vapid = v
	return v, nil
}

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

// sanitizeText keeps printable characters on one line.
func sanitizeText(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, strings.TrimSpace(s))
}
