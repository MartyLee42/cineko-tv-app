// Package alerts tells admins when something the household depends on
// breaks: TMDB, YouTube (Invidious), TorrServer, Prowlarr, the VPN proxy,
// the disk or the database. The API's monitor feeds its own cached checks
// into a debounce state machine (Machine) once a minute; the host scripts
// (watchdog, image updater) report what they see and do through
// POST /internal/incident. Incidents are stored in the DB; admins get a
// Cineko message in their inbox and, when they opted in, a Web Push.
package alerts

import (
	"sort"
	"time"
)

// Kinds. The monitor's own checks first, then the host-reported ones.
const (
	KindTMDB       = "tmdb"
	KindProwlarr   = "prowlarr"
	KindTorrServer = "torrserver"
	KindInvidious  = "invidious" // Invidious doesn't answer (API probe)
	KindProxy      = "proxy"     // the outbound proxy (VPN) refuses connections
	KindDisk       = "disk"
	KindDatabase   = "database"

	KindYouTube = "youtube" // host watchdog: search or streams fail
	KindVPN     = "vpn"     // host watchdog: YouTube and TMDB fail through the VPN
	KindUpdater = "updater" // host image updater: one-off events (rollback)
)

// Sources.
const (
	SourceMonitor = "monitor"
	SourceHost    = "host"
)

// Observation is one check result.
type Observation struct {
	Kind   string
	OK     bool
	Cause  string // short code, e.g. "unauthorized", "streams"
	Detail string // free text for the admin list (never a secret)
	Source string
	// Confirmed: the reporter already debounced (host scripts): a failure
	// opens the incident at once and one OK closes it.
	Confirmed bool
	// Actions taken (host): attached to the incident as notes.
	Actions []string
}

// EventType is what the monitor must announce.
type EventType int

const (
	EventOpened EventType = iota + 1
	EventRecovered
	EventReminder
	EventClosedSilently // stale (no reports any more): no notice
	EventUpdated        // cause or notes changed while open: no notice
)

// Event is a state change of one kind.
type Event struct {
	Type     EventType
	Kind     string
	Cause    string
	Detail   string
	Source   string
	Notes    []string
	OpenedAt time.Time
	At       time.Time
	// ID of the stored incident (set by the caller via Machine.SetID).
	ID string
}

// Duration is how long the incident has been open at the event.
func (e Event) Duration() time.Duration { return e.At.Sub(e.OpenedAt) }

type tracker struct {
	fails, oks int
	open       bool
	id         string
	cause      string
	detail     string
	source     string
	notes      []string
	openedAt   time.Time
	notifiedAt time.Time
	lastSeen   time.Time
	// actions reported before the incident opened, kept for its notes.
	pending []timedNote
}

type timedNote struct {
	at   time.Time
	note string
}

// Machine is the debounce state machine. Not safe for concurrent use.
type Machine struct {
	// OpenAfter consecutive failures open an incident (monitor checks run
	// once a minute: 3 ≈ 3 minutes).
	OpenAfter int
	// CloseAfter consecutive OKs close it (avoids flapping).
	CloseAfter int
	// RemindEvery: at most one reminder per interval while open.
	RemindEvery time.Duration
	// StaleAfter: an open incident nobody reports on any more closes silently.
	StaleAfter time.Duration
	// Interval between monitor checks (dates an incident to its first failure).
	Interval time.Duration
	t        map[string]*tracker
}

// NewMachine returns the defaults: open after 3 failures, close after 2 OKs,
// remind every 6 h, stale after 20 min.
func NewMachine() *Machine {
	return &Machine{OpenAfter: 3, CloseAfter: 2, RemindEvery: 6 * time.Hour, StaleAfter: 20 * time.Minute,
		Interval: time.Minute, t: map[string]*tracker{}}
}

func (m *Machine) get(kind string) *tracker {
	tr := m.t[kind]
	if tr == nil {
		tr = &tracker{}
		m.t[kind] = tr
	}
	return tr
}

// Restore marks an incident loaded from the DB as open (after a restart).
func (m *Machine) Restore(kind, id, cause, detail, source string, notes []string, openedAt, notifiedAt, now time.Time) {
	tr := m.get(kind)
	*tr = tracker{open: true, id: id, cause: cause, detail: detail, source: source, notes: append([]string(nil), notes...),
		openedAt: openedAt, notifiedAt: notifiedAt, lastSeen: now}
}

// SetID records the stored incident's id for kind.
func (m *Machine) SetID(kind, id string) {
	if tr := m.t[kind]; tr != nil && tr.open {
		tr.id = id
	}
}

// Open reports whether kind has an open incident.
func (m *Machine) Open(kind string) bool {
	tr := m.t[kind]
	return tr != nil && tr.open
}

const pendingFor = 30 * time.Minute

// Observe feeds one result; it returns the event to announce, if any.
func (m *Machine) Observe(now time.Time, o Observation) (Event, bool) {
	tr := m.get(o.Kind)
	tr.lastSeen = now
	ev := func(t EventType) Event {
		return Event{Type: t, Kind: o.Kind, Cause: tr.cause, Detail: tr.detail, Source: tr.source,
			Notes: append([]string(nil), tr.notes...), OpenedAt: tr.openedAt, At: now, ID: tr.id}
	}
	if o.OK {
		tr.fails = 0
		tr.oks++
		tr.pending = nil
		if !tr.open || (!o.Confirmed && tr.oks < m.CloseAfter) {
			return Event{}, false
		}
		e := ev(EventRecovered)
		*tr = tracker{lastSeen: now}
		return e, true
	}
	tr.oks = 0
	tr.fails++
	if tr.open {
		changed := false
		if o.Cause != "" && o.Cause != tr.cause {
			tr.cause, changed = o.Cause, true
		}
		if o.Detail != "" && o.Detail != tr.detail {
			tr.detail = o.Detail // detail alone (e.g. free space) isn't worth a write
		}
		for _, a := range o.Actions {
			tr.notes, changed = append(tr.notes, a), true
		}
		if changed {
			return ev(EventUpdated), true
		}
		return Event{}, false
	}
	// Not open yet: remember the actions, open after enough failures.
	for _, a := range o.Actions {
		tr.pending = append(tr.pending, timedNote{at: now, note: a})
	}
	if !o.Confirmed && tr.fails < m.OpenAfter {
		return Event{}, false
	}
	tr.open, tr.cause, tr.detail, tr.source = true, o.Cause, o.Detail, o.Source
	tr.openedAt, tr.notifiedAt = now, now
	if !o.Confirmed {
		// It has been failing since the first of the failed checks.
		tr.openedAt = now.Add(-time.Duration(tr.fails-1) * m.Interval)
	}
	tr.notes = nil
	for _, p := range tr.pending {
		if now.Sub(p.at) <= pendingFor {
			tr.notes = append(tr.notes, p.note)
		}
	}
	tr.pending = nil
	return ev(EventOpened), true
}

// Note attaches a one-off action to kind (host events without a state):
// to the open incident, else kept for one that opens within 30 minutes.
func (m *Machine) Note(now time.Time, kind, note string) (Event, bool) {
	tr := m.get(kind)
	if !tr.open {
		tr.pending = append(tr.pending, timedNote{at: now, note: note})
		return Event{}, false
	}
	tr.notes = append(tr.notes, note)
	return Event{Type: EventUpdated, Kind: kind, Cause: tr.cause, Detail: tr.detail, Source: tr.source,
		Notes: append([]string(nil), tr.notes...), OpenedAt: tr.openedAt, At: now, ID: tr.id}, true
}

// Tick returns reminders due and silently closes stale incidents.
func (m *Machine) Tick(now time.Time) []Event {
	kinds := make([]string, 0, len(m.t))
	for k := range m.t {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	var out []Event
	for _, k := range kinds {
		tr := m.t[k]
		if !tr.open {
			continue
		}
		e := Event{Kind: k, Cause: tr.cause, Detail: tr.detail, Source: tr.source, Notes: append([]string(nil), tr.notes...),
			OpenedAt: tr.openedAt, At: now, ID: tr.id}
		switch {
		case m.StaleAfter > 0 && now.Sub(tr.lastSeen) > m.StaleAfter:
			e.Type = EventClosedSilently
			*tr = tracker{}
		case now.Sub(tr.notifiedAt) >= m.RemindEvery:
			e.Type = EventReminder
			tr.notifiedAt = now
		default:
			continue
		}
		out = append(out, e)
	}
	return out
}
