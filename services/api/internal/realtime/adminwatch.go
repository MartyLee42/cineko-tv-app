package realtime

// Grant is a caller's access to one device (Access.DeviceAccess).
type Grant struct {
	Level       string // owner | use | control; "" = no access
	ViaAdmin    bool   // only the super_admin role grants it (Level is control)
	OwnerUserID string
}

// A super_admin controlling someone else's TV over the socket isn't in the
// device's AuthorizedUserIDs, so their socket is remembered as a watcher of
// that device until it disconnects: it then gets the TV's device.state and
// device.presence like the owner (the remote stays live). Only devices the
// super_admin actually commanded are watched, so other households' playback
// never reaches their client unasked.

// watchIfAdmin registers sink (a socket) as a watcher of deviceID when the
// grant comes from the super_admin role.
func (h *Hub) watchIfAdmin(sink ackSink, g Grant, deviceID string) {
	c, ok := sink.(*Client)
	if !ok || !g.ViaAdmin {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.watch[deviceID]
	if set == nil {
		set = map[*Client]struct{}{}
		h.watch[deviceID] = set
	}
	set[c] = struct{}{}
}

// unwatchLocked forgets a closed socket (h.mu held).
func (h *Hub) unwatchLocked(c *Client) {
	for id, set := range h.watch {
		delete(set, c)
		if len(set) == 0 {
			delete(h.watch, id)
		}
	}
}

// sendToDeviceUsers delivers a device event to the users with access plus
// the device's super_admin watchers, each socket once.
func (h *Hub) sendToDeviceUsers(deviceID string, userIDs []string, env Envelope) {
	h.mu.Lock()
	targets := map[*Client]struct{}{}
	for _, uid := range userIDs {
		for c := range h.users[uid] {
			targets[c] = struct{}{}
		}
	}
	for c := range h.watch[deviceID] {
		targets[c] = struct{}{}
	}
	h.mu.Unlock()
	for c := range targets {
		c.Send(env)
	}
}
