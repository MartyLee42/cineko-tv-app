package server

import (
	"io"
	"math/rand/v2"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
)

// Background connection speed test (TV + PWA «Измерять скорость интернета в
// фоне»): GET /speedtest?bytes=N streams N incompressible bytes so a device
// can time the path that matters — from it to this server, where its streams
// come from. Caddy must not compress it (deployments/Caddyfile).
const (
	// SpeedtestMaxBytes caps one response (a test grows its sample to ~4 s).
	SpeedtestMaxBytes = 25 << 20
	speedtestDefault  = 1 << 20
	// speedtestBlock is the random block repeated to fill a response: larger
	// than gzip's/zstd's default windows, so nothing on the way can shrink it.
	speedtestBlock = 4 << 20
	// speedtestConcurrent bounds tests running at once (all principals).
	speedtestConcurrent = 4
)

type speedtestService struct {
	block  []byte
	limit  *httpx.RateLimiter
	active atomic.Int64
}

func newSpeedtestService() *speedtestService {
	b := make([]byte, speedtestBlock)
	r := rand.New(rand.NewPCG(rand.Uint64(), rand.Uint64()))
	for i := 0; i < len(b); i += 8 {
		v := r.Uint64()
		for j := 0; j < 8 && i+j < len(b); j++ {
			b[i+j] = byte(v >> (8 * j))
		}
	}
	// A test is 2–4 requests; 30 per 10 min per principal leaves room for
	// manual «Проверить сейчас» without letting a client saturate the uplink.
	return &speedtestService{block: b, limit: httpx.NewRateLimiter(30, 10*time.Minute)}
}

// repeatReader yields n bytes from block, cycling.
type repeatReader struct {
	block []byte
	off   int
	left  int64
	done  func()
}

func (r *repeatReader) Read(p []byte) (int, error) {
	if r.left <= 0 {
		r.finish()
		return 0, io.EOF
	}
	if int64(len(p)) > r.left {
		p = p[:r.left]
	}
	n := copy(p, r.block[r.off:])
	r.off = (r.off + n) % len(r.block)
	r.left -= int64(n)
	return n, nil
}

func (r *repeatReader) Close() error {
	r.finish()
	return nil
}

func (r *repeatReader) finish() {
	if r.done != nil {
		r.done()
		r.done = nil
	}
}

// Routes registers GET /speedtest for any signed-in reader (users, TVs, tokens).
func (s *speedtestService) Routes(api fiber.Router) {
	api.Get("/speedtest", auth.RequireReader(), func(c fiber.Ctx) error {
		n := int64(speedtestDefault)
		if v := c.Query("bytes"); v != "" {
			x, err := strconv.ParseInt(v, 10, 64)
			if err != nil || x < 1 || x > SpeedtestMaxBytes {
				return httpx.Validation(map[string]string{"bytes": "Must be 1…" + strconv.Itoa(SpeedtestMaxBytes) + "."})
			}
			n = x
		}
		p := auth.PrincipalFrom(c)
		key := "u:" + p.UserID
		if p.Kind == auth.KindDevice {
			key = "d:" + p.DeviceID
		}
		if ok, wait := s.limit.Allow(key); !ok {
			return httpx.TooManyRequests(wait)
		}
		if s.active.Add(1) > speedtestConcurrent {
			s.active.Add(-1)
			return httpx.TooManyRequests(5 * time.Second)
		}
		c.Set(fiber.HeaderContentType, "application/octet-stream")
		c.Set(fiber.HeaderCacheControl, "no-store")
		c.Set("X-Accel-Buffering", "no")
		start := int(rand.Int64N(int64(len(s.block))))
		body := &repeatReader{block: s.block, off: start, left: n, done: func() { s.active.Add(-1) }}
		return c.SendStream(body, int(n))
	})
}
