package realtime

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/gofiber/contrib/v3/websocket"
	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
)

const (
	writeWait       = 10 * time.Second
	pongWait        = 60 * time.Second
	pingEvery       = 20 * time.Second
	authWait        = 5 * time.Second
	revalidateEvery = 5 * time.Minute
	maxMessageBytes = 64 << 10
)

// Client is one WebSocket connection (a TV or a controller).
type Client struct {
	hub       *Hub
	conn      *websocket.Conn
	p         *auth.Principal
	send      chan Envelope
	done      chan struct{}
	closeOnce sync.Once
	reason    string
}

// Send queues a message. Slow consumers are disconnected rather than
// allowed to block the hub.
func (c *Client) Send(env Envelope) {
	select {
	case <-c.done:
	case c.send <- env:
	default:
		c.Close("send queue full")
	}
}

// Close ends the connection with a reason sent to the peer.
func (c *Client) Close(reason string) {
	c.closeOnce.Do(func() {
		c.reason = reason
		close(c.done)
	})
}

// Handler serves /api/v1/ws.
type Handler struct {
	hub     *Hub
	auth    *auth.Service
	origins []string
}

func NewHandler(hub *Hub, svc *auth.Service, allowedOrigins []string) *Handler {
	return &Handler{hub: hub, auth: svc, origins: allowedOrigins}
}

// Upgrade must run after auth.Middleware.Authenticate.
func (h *Handler) Upgrade() fiber.Handler {
	ws := websocket.New(h.serve, websocket.Config{
		// Browsers must come from an allowed origin; clients without an Origin
		// header (CLI tools, some TV runtimes) must authenticate by token.
		Origins:          h.origins,
		AllowEmptyOrigin: true,
	})
	return func(c fiber.Ctx) error {
		if !websocket.IsWebSocketUpgrade(c) {
			return fiber.ErrUpgradeRequired
		}
		// ?auth=token: the client (the TV app) authenticates with its first
		// message and any session cookie in the browser must be ignored.
		if p := auth.PrincipalFrom(c); p != nil && c.Query("auth") != "token" {
			c.Locals("ws_principal", p)
			c.Locals("ws_cookie", auth.SessionToken(c))
			c.Locals("ws_bearer", auth.ParseBearer(c.Get(fiber.HeaderAuthorization)))
		}
		if c.Get(fiber.HeaderOrigin) != "" && !httpx.MatchOrigin(c.Get(fiber.HeaderOrigin), h.origins) {
			return httpx.NewError(fiber.StatusForbidden, "bad_origin", "WebSocket origin is not allowed.")
		}
		return ws(c)
	}
}

func (h *Handler) serve(conn *websocket.Conn) {
	conn.SetReadLimit(maxMessageBytes)
	p, _ := conn.Locals("ws_principal").(*auth.Principal)
	cookie, _ := conn.Locals("ws_cookie").(string)
	bearer, _ := conn.Locals("ws_bearer").(string)

	if p == nil {
		// First-message authentication for clients that cannot send cookies
		// or headers on a WebSocket (the TV app).
		var err error
		p, bearer, err = h.firstMessageAuth(conn)
		if err != nil {
			writeClose(conn, websocket.ClosePolicyViolation, "authentication required")
			return
		}
	}

	if p.Demo {
		// «Демо TV» (/demo_tv) stays off the socket: no presence, no remote
		// control, no pushes (the app does not connect at all).
		writeClose(conn, websocket.ClosePolicyViolation, "demo device")
		return
	}

	c := &Client{hub: h.hub, conn: conn, p: p, send: make(chan Envelope, sendQueueLength), done: make(chan struct{})}
	h.hub.register(c)
	defer h.hub.unregister(c)

	hello := map[string]any{"kind": p.Kind, "user_id": p.UserID}
	if p.Kind == auth.KindDevice {
		hello["device_id"] = p.DeviceID
	}
	c.Send(Envelope{Type: TypeHello, Payload: mustJSON(hello)})

	revalidate := func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var err error
		if cookie != "" {
			_, err = h.auth.ResolveSession(ctx, cookie)
		} else {
			_, err = h.auth.ResolveBearer(ctx, bearer)
		}
		return err == nil
	}

	go c.writePump(revalidate)
	c.readPump()
}

func (h *Handler) firstMessageAuth(conn *websocket.Conn) (*auth.Principal, string, error) {
	_ = conn.SetReadDeadline(time.Now().Add(authWait))
	_, data, err := conn.ReadMessage()
	if err != nil {
		return nil, "", err
	}
	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil || env.Type != TypeAuth {
		return nil, "", fiber.ErrUnauthorized
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(env.Payload, &body); err != nil || body.Token == "" {
		return nil, "", fiber.ErrUnauthorized
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p, err := h.auth.ResolveBearer(ctx, body.Token)
	if err != nil {
		return nil, "", err
	}
	if p.Kind == auth.KindToken && !p.HasScope(auth.ScopeWrite) {
		return nil, "", fiber.ErrForbidden
	}
	return p, body.Token, nil
}

func (c *Client) readPump() {
	defer c.Close("read closed")
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		var env Envelope
		if err := json.Unmarshal(data, &env); err != nil || env.Type == "" {
			c.Send(errorEnvelope("", ErrBadMessage, "malformed message"))
			continue
		}
		if env.Type == TypePing {
			// App-level heartbeat for runtimes that hide WebSocket ping frames.
			c.Send(Envelope{ID: env.ID, Type: TypePong})
			continue
		}
		if c.p.Kind == auth.KindDevice {
			c.hub.handleDeviceMessage(c, env)
		} else {
			c.hub.handleControllerMessage(c, env)
		}
	}
}

func (c *Client) writePump(revalidate func() bool) {
	ping := time.NewTicker(pingEvery)
	recheck := time.NewTicker(revalidateEvery)
	defer func() {
		ping.Stop()
		recheck.Stop()
		writeClose(c.conn, websocket.CloseNormalClosure, c.reason)
		_ = c.conn.Close()
	}()
	for {
		select {
		case <-c.done:
			return
		case env := <-c.send:
			b, err := json.Marshal(env)
			if err != nil {
				continue
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, b); err != nil {
				c.Close("write failed")
				return
			}
		case <-ping.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				c.Close("ping failed")
				return
			}
		case <-recheck.C:
			// Catch credentials that expired (rather than being revoked) while connected.
			if !revalidate() {
				c.Close("credentials expired")
				return
			}
		}
	}
}

func writeClose(conn *websocket.Conn, code int, reason string) {
	if len(reason) > 120 {
		reason = reason[:120]
	}
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
}
