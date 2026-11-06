package realtime

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"martytv/api/internal/auth"
)

// Access answers authorization questions for the hub.
type Access interface {
	// DeviceAccess returns the caller's grant on a device (Level "" when they
	// may not reach it). A super_admin gets "control" on anyone's device, with
	// ViaAdmin set (see devices.Store.AccessFor).
	DeviceAccess(ctx context.Context, p *auth.Principal, deviceID string) (Grant, error)
	// AdminCommand audits a command a super_admin sent via the role.
	AdminCommand(ctx context.Context, p *auth.Principal, deviceID, ownerUserID, commandType string)
	AuthorizedUserIDs(ctx context.Context, deviceID string) ([]string, error)
	// MediaExists reports whether an internal media id is known.
	MediaExists(ctx context.Context, mediaID string) (bool, error)
	// Sender describes a user for the `from` field of forwarded commands.
	Sender(ctx context.Context, userID string) (Sender, error)
}

// ackSink receives the outcome of a command: a WebSocket client, or an HTTP
// request waiting in SendCommand.
type ackSink interface {
	Send(Envelope)
}

// chanSink delivers acks to a waiting HTTP request.
type chanSink struct{ ch chan Envelope }

func (c chanSink) Send(env Envelope) {
	// Only the ack ends an HTTP request; ignore the cached device.state the
	// hub sends ahead of request_state (that's for socket clients).
	if env.Type != TypeAck {
		return
	}
	select {
	case c.ch <- env:
	default:
	}
}

// CommandTimeout is how long the hub waits for a TV's ack (a var for tests).
var CommandTimeout = 10 * time.Second

const (
	idempotencyTTL  = 5 * time.Minute
	sendQueueLength = 64
)

// Hub tracks live connections. One process serves the whole deployment, so
// all state is in memory.
type Hub struct {
	access Access
	log    *slog.Logger

	mu      sync.Mutex
	devices map[string]*Client              // deviceID → TV connection
	users   map[string]map[*Client]struct{} // userID → controller connections
	states  map[string]json.RawMessage      // deviceID → last reported state
	pending map[string]*pendingCommand      // deviceID/commandID → in-flight command
	results map[string]resultEntry          // deviceID/commandID → final ack (idempotency)
	watch   map[string]map[*Client]struct{} // deviceID → super_admin sockets controlling it via the role (adminwatch.go)

	// admin.devices.updated throttle (AdminDevicesChanged).
	adminMu      sync.Mutex
	adminLast    time.Time
	adminPending string // reason of a scheduled trailing send ("" = none)
}

// AdminDevicesThrottle is the minimum gap between admin.devices.updated
// events (a var for tests).
var AdminDevicesThrottle = time.Second

type pendingCommand struct {
	deviceID string
	waiters  map[ackSink]struct{}
	timer    *time.Timer
}

type resultEntry struct {
	ack Envelope
	at  time.Time
}

func NewHub(access Access, log *slog.Logger) *Hub {
	return &Hub{
		access: access, log: log,
		devices: map[string]*Client{},
		users:   map[string]map[*Client]struct{}{},
		states:  map[string]json.RawMessage{},
		pending: map[string]*pendingCommand{},
		results: map[string]resultEntry{},
		watch:   map[string]map[*Client]struct{}{},
	}
}

// IsOnline reports whether a TV currently holds a connection.
func (h *Hub) IsOnline(deviceID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.devices[deviceID]
	return ok
}

// Counts reports live connections: distinct users with a browser/app socket
// and TVs online (read-only, for the admin system monitor).
func (h *Hub) Counts() (users, devices int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.users), len(h.devices)
}

func (h *Hub) register(c *Client) {
	h.mu.Lock()
	var replaced *Client
	if c.p.Kind == auth.KindDevice {
		replaced = h.devices[c.p.DeviceID]
		h.devices[c.p.DeviceID] = c
	} else {
		set := h.users[c.p.UserID]
		if set == nil {
			set = map[*Client]struct{}{}
			h.users[c.p.UserID] = set
		}
		set[c] = struct{}{}
	}
	h.mu.Unlock()

	if replaced != nil {
		// A TV reconnected before its old socket timed out; the newest wins.
		replaced.Close("replaced by a newer connection")
	}
	if c.p.Kind == auth.KindDevice && replaced == nil {
		h.broadcastPresence(c.p.DeviceID, true)
		h.AdminDevicesChanged("device.online")
	}
}

func (h *Hub) unregister(c *Client) {
	h.mu.Lock()
	wentOffline := false
	if c.p.Kind == auth.KindDevice {
		if h.devices[c.p.DeviceID] == c {
			delete(h.devices, c.p.DeviceID)
			delete(h.states, c.p.DeviceID)
			wentOffline = true
		}
	} else if set := h.users[c.p.UserID]; set != nil {
		h.unwatchLocked(c)
		delete(set, c)
		if len(set) == 0 {
			delete(h.users, c.p.UserID)
		}
	}
	var failed []*pendingCommand
	var failedIDs []string
	for key, pc := range h.pending {
		if wentOffline && pc.deviceID == c.p.DeviceID {
			pc.timer.Stop()
			failed = append(failed, pc)
			failedIDs = append(failedIDs, commandIDFromKey(key))
			delete(h.pending, key)
		} else {
			delete(pc.waiters, c)
		}
	}
	h.mu.Unlock()

	for i, pc := range failed {
		h.sendAckTo(pc.waiters, pc.deviceID, failedIDs[i], AckPayload{OK: false, Error: ErrDeviceOffline})
	}
	if wentOffline {
		h.broadcastPresence(c.p.DeviceID, false)
		h.AdminDevicesChanged("device.offline")
	}
}

// sendToUsers delivers env to every controller connection of the given users.
func (h *Hub) sendToUsers(userIDs []string, env Envelope) {
	h.mu.Lock()
	var targets []*Client
	for _, uid := range userIDs {
		for c := range h.users[uid] {
			targets = append(targets, c)
		}
	}
	h.mu.Unlock()
	for _, c := range targets {
		c.Send(env)
	}
}

func (h *Hub) broadcastPresence(deviceID string, online bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ids, err := h.access.AuthorizedUserIDs(ctx, deviceID)
	if err != nil {
		h.log.Warn("presence lookup failed", "device_id", deviceID, "err", err)
		return
	}
	h.sendToDeviceUsers(deviceID, ids, Envelope{Type: TypeDevicePresence, DeviceID: deviceID,
		Payload: mustJSON(map[string]bool{"online": online})})
}

// DeviceChanged notifies everyone with access (plus extraUserIDs, e.g. users
// who just lost access) that a device's metadata or permissions changed.
func (h *Hub) DeviceChanged(ctx context.Context, deviceID string, extraUserIDs ...string) {
	ids, err := h.access.AuthorizedUserIDs(ctx, deviceID)
	if err != nil {
		h.log.Warn("device change lookup failed", "device_id", deviceID, "err", err)
	}
	ids = append(ids, extraUserIDs...)
	h.sendToUsers(ids, Envelope{Type: TypeDeviceChanged, DeviceID: deviceID})
	h.AdminDevicesChanged("device.changed")
}

// UserDevicesChanged tells one user's browser sockets that their device list
// changed without naming a device (e.g. a super_admin approved a TV for them
// that hasn't collected its credential yet): device.changed, no device_id.
func (h *Hub) UserDevicesChanged(userID string) {
	h.sendToUsers([]string{userID}, Envelope{Type: TypeDeviceChanged})
}

// AdminDevicesChanged pushes admin.devices.updated {reason} to every
// super_admin browser socket, at most once per AdminDevicesThrottle: a burst
// sends the first event at once and one trailing event (the latest reason)
// after the gap. The event carries no device data; the page refetches
// /admin/devices and /admin/pairing, which check the role again.
func (h *Hub) AdminDevicesChanged(reason string) {
	h.adminMu.Lock()
	wait := AdminDevicesThrottle - time.Since(h.adminLast)
	if wait > 0 {
		scheduled := h.adminPending != ""
		h.adminPending = reason
		h.adminMu.Unlock()
		if !scheduled {
			time.AfterFunc(wait, func() {
				h.adminMu.Lock()
				r := h.adminPending
				h.adminPending = ""
				h.adminLast = time.Now()
				h.adminMu.Unlock()
				h.sendToSuperAdmins(r)
			})
		}
		return
	}
	h.adminLast = time.Now()
	h.adminMu.Unlock()
	h.sendToSuperAdmins(reason)
}

func (h *Hub) sendToSuperAdmins(reason string) {
	env := Envelope{Type: TypeAdminDevicesUpdated, Payload: mustJSON(map[string]string{"reason": reason})}
	h.mu.Lock()
	var targets []*Client
	for _, set := range h.users {
		for c := range set {
			if c.p.Kind != auth.KindDevice && c.p.IsSuperAdmin() && c.p.HasScope(auth.ScopeAdmin) {
				targets = append(targets, c)
			}
		}
	}
	h.mu.Unlock()
	for _, c := range targets {
		c.Send(env)
	}
}

// handleDeviceMessage processes a message from a TV.
func (h *Hub) handleDeviceMessage(c *Client, env Envelope) {
	deviceID := c.p.DeviceID
	switch env.Type {
	case TypeDeviceState:
		h.mu.Lock()
		h.states[deviceID] = env.Payload
		h.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		ids, err := h.access.AuthorizedUserIDs(ctx, deviceID)
		if err != nil {
			return
		}
		h.sendToDeviceUsers(deviceID, ids, Envelope{Type: TypeDeviceState, DeviceID: deviceID, Payload: env.Payload})
	case TypeAck:
		if env.ID == "" {
			return
		}
		var ack AckPayload
		if json.Unmarshal(env.Payload, &ack) != nil {
			ack = AckPayload{OK: false, Error: ErrBadMessage}
		}
		key := commandKey(deviceID, env.ID)
		h.mu.Lock()
		pc := h.pending[key]
		delete(h.pending, key)
		final := Envelope{ID: env.ID, Type: TypeAck, DeviceID: deviceID, Payload: mustJSON(ack)}
		if pc != nil {
			pc.timer.Stop()
			h.results[key] = resultEntry{ack: final, at: time.Now()}
		}
		h.mu.Unlock()
		if pc != nil {
			for w := range pc.waiters {
				w.Send(final)
			}
		}
	default:
		c.Send(errorEnvelope(env.ID, ErrBadMessage, "unsupported message type for a device"))
	}
}

// handleControllerMessage processes a message from a phone/browser.
func (h *Hub) handleControllerMessage(c *Client, env Envelope) {
	if !isCommand(env.Type) {
		c.Send(errorEnvelope(env.ID, ErrBadMessage, "unknown message type"))
		return
	}
	if env.ID == "" || len(env.ID) > 64 || env.TargetDeviceID == "" {
		c.Send(errorEnvelope(env.ID, ErrBadMessage, "commands need id and target_device_id"))
		return
	}
	h.dispatch(c, c.p, env)
}

// SendCommand runs a command for an HTTP caller and waits for its ack (or a
// server-side error ack). id may be empty; one is generated.
func (h *Hub) SendCommand(ctx context.Context, p *auth.Principal, deviceID, id, typ string, payload json.RawMessage) Envelope {
	if id == "" {
		id = newCommandID()
	}
	sink := chanSink{ch: make(chan Envelope, 1)}
	h.dispatch(sink, p, Envelope{ID: id, Type: typ, TargetDeviceID: deviceID, Payload: payload})
	wait := time.NewTimer(CommandTimeout + 2*time.Second)
	defer wait.Stop()
	select {
	case ack := <-sink.ch:
		return ack
	case <-wait.C:
		return ackEnvelope(id, deviceID, AckPayload{OK: false, Error: ErrTimeout})
	case <-ctx.Done():
		h.dropWaiter(deviceID, id, sink)
		return ackEnvelope(id, deviceID, AckPayload{OK: false, Error: ErrTimeout})
	}
}

// dispatch authorizes, validates and forwards a command, registering sink to
// receive the outcome. Shared by the WebSocket and HTTP paths.
func (h *Hub) dispatch(sink ackSink, p *auth.Principal, env Envelope) {
	deviceID := env.TargetDeviceID
	reply := func(code string) {
		sink.Send(ackEnvelope(env.ID, deviceID, AckPayload{OK: false, Error: code}))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	grant, err := h.access.DeviceAccess(ctx, p, deviceID)
	if err != nil || grant.Level == "" {
		reply(ErrForbidden)
		return
	}
	h.watchIfAdmin(sink, grant, deviceID)

	key := commandKey(deviceID, env.ID)
	h.mu.Lock()
	h.sweepResultsLocked()
	if res, ok := h.results[key]; ok {
		// Retried command that already completed: replay the outcome.
		h.mu.Unlock()
		sink.Send(res.ack)
		return
	}
	if pc, ok := h.pending[key]; ok {
		// Retried while still in flight: wait for the same result.
		pc.waiters[sink] = struct{}{}
		h.mu.Unlock()
		return
	}
	h.mu.Unlock()

	payload, mediaIDs, err := ValidatePayload(env.Type, env.Payload)
	if err != nil {
		reply(ErrBadPayload)
		return
	}
	for _, id := range mediaIDs {
		ok, err := h.access.MediaExists(ctx, id)
		if err != nil {
			reply(ErrFailed)
			return
		}
		if !ok {
			reply(ErrNotFound)
			return
		}
	}
	sender, err := h.access.Sender(ctx, p.UserID)
	if err != nil {
		sender = Sender{UserID: p.UserID, Username: p.Username}
	}

	h.mu.Lock()
	if env.Type == "device.request_state" {
		if st, ok := h.states[deviceID]; ok {
			sink.Send(Envelope{Type: TypeDeviceState, DeviceID: deviceID, Payload: st})
		}
	}
	tv := h.devices[deviceID]
	if tv == nil {
		h.mu.Unlock()
		reply(ErrDeviceOffline)
		return
	}
	if pc, ok := h.pending[key]; ok { // raced with an identical retry
		pc.waiters[sink] = struct{}{}
		h.mu.Unlock()
		return
	}
	pc := &pendingCommand{deviceID: deviceID, waiters: map[ackSink]struct{}{sink: {}}}
	pc.timer = time.AfterFunc(CommandTimeout, func() { h.expire(key, env.ID) })
	h.pending[key] = pc
	h.mu.Unlock()

	tv.Send(Envelope{ID: env.ID, Type: env.Type, Payload: payload, DeviceID: deviceID, From: &sender})
	if grant.ViaAdmin && env.Type != "device.request_state" {
		h.access.AdminCommand(ctx, p, deviceID, grant.OwnerUserID, env.Type)
	}
}

func (h *Hub) dropWaiter(deviceID, commandID string, sink ackSink) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if pc := h.pending[commandKey(deviceID, commandID)]; pc != nil {
		delete(pc.waiters, sink)
	}
}

// LastState returns the TV's last reported state (nil if offline/unknown).
func (h *Hub) LastState(deviceID string) json.RawMessage {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.states[deviceID]
}

// Command adapts SendCommand for the devices HTTP handler.
func (h *Hub) Command(ctx context.Context, p *auth.Principal, deviceID, id, typ string, payload json.RawMessage) (string, json.RawMessage) {
	ack := h.SendCommand(ctx, p, deviceID, id, typ, payload)
	return ack.ID, ack.Payload
}

func ackEnvelope(id, deviceID string, ack AckPayload) Envelope {
	return Envelope{ID: id, Type: TypeAck, DeviceID: deviceID, Payload: mustJSON(ack)}
}

func (h *Hub) expire(key, commandID string) {
	h.mu.Lock()
	pc := h.pending[key]
	delete(h.pending, key)
	h.mu.Unlock()
	if pc != nil {
		// Timeouts are not cached, so a client retry re-delivers the command.
		h.sendAckTo(pc.waiters, pc.deviceID, commandID, AckPayload{OK: false, Error: ErrTimeout})
	}
}

func (h *Hub) sendAckTo(waiters map[ackSink]struct{}, deviceID, commandID string, ack AckPayload) {
	env := ackEnvelope(commandID, deviceID, ack)
	for w := range waiters {
		w.Send(env)
	}
}

func (h *Hub) sweepResultsLocked() {
	if len(h.results) < 256 {
		return
	}
	cutoff := time.Now().Add(-idempotencyTTL)
	for k, r := range h.results {
		if r.at.Before(cutoff) {
			delete(h.results, k)
		}
	}
}

// ---- revocation (auth.Disconnector) ----

func (h *Hub) closeWhere(match func(*Client) bool, reason string) {
	h.mu.Lock()
	var hit []*Client
	for _, c := range h.devices {
		if match(c) {
			hit = append(hit, c)
		}
	}
	for _, set := range h.users {
		for c := range set {
			if match(c) {
				hit = append(hit, c)
			}
		}
	}
	h.mu.Unlock()
	for _, c := range hit {
		c.Close(reason)
	}
}

func (h *Hub) DisconnectSession(id string) {
	h.closeWhere(func(c *Client) bool { return c.p.SessionID == id }, "session revoked")
}
func (h *Hub) DisconnectToken(id string) {
	h.closeWhere(func(c *Client) bool { return c.p.TokenID == id }, "token revoked")
}
func (h *Hub) DisconnectUser(id string) {
	h.closeWhere(func(c *Client) bool { return c.p.Kind != auth.KindDevice && c.p.UserID == id }, "signed out")
}
func (h *Hub) DisconnectDevice(id string) {
	h.closeWhere(func(c *Client) bool { return c.p.DeviceID == id }, "device revoked")
}

func commandKey(deviceID, commandID string) string { return deviceID + "/" + commandID }

func commandIDFromKey(key string) string {
	for i := 0; i < len(key); i++ {
		if key[i] == '/' {
			return key[i+1:]
		}
	}
	return key
}

func errorEnvelope(id, code, msg string) Envelope {
	return Envelope{ID: id, Type: TypeError, Payload: mustJSON(map[string]string{"code": code, "message": msg})}
}

// ---- Phase 5: admin messages and activity ----

// NotifyUsers sends env to every controller (browser/phone) socket of the users.
func (h *Hub) NotifyUsers(userIDs []string, env Envelope) { h.sendToUsers(userIDs, env) }

// NotifyDevicesOwnedBy sends env to the connected TVs owned by the users.
func (h *Hub) NotifyDevicesOwnedBy(userIDs []string, env Envelope) {
	owners := make(map[string]bool, len(userIDs))
	for _, id := range userIDs {
		owners[id] = true
	}
	h.mu.Lock()
	var targets []*Client
	for _, c := range h.devices {
		if owners[c.p.UserID] {
			targets = append(targets, c)
		}
	}
	h.mu.Unlock()
	for _, c := range targets {
		c.Send(env)
	}
}

// NotifyDevice sends env to one connected TV; false when it is offline.
func (h *Hub) NotifyDevice(deviceID string, env Envelope) bool {
	h.mu.Lock()
	c := h.devices[deviceID]
	h.mu.Unlock()
	if c == nil {
		return false
	}
	c.Send(env)
	return true
}

// LiveStates returns a copy of the last reported state of every connected TV.
func (h *Hub) LiveStates() map[string]json.RawMessage {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make(map[string]json.RawMessage, len(h.states))
	for id, st := range h.states {
		out[id] = st
	}
	return out
}
