package downloads

// Admin «Торренты в TorrServer»: list the household TorrServer's torrents
// (shared with Lampa) and remove them. Only POST /torrents {"action":"list"}
// and {"action":"rem","hash":…} are used (verified in the MatriX.141 swagger,
// docs/integrations/torrserver-matrix141.swagger.json: api.torrReqJS, "hash
// required for get, set, rem, drop"). Nothing else in TorrServer is touched.

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
	"martytv/api/internal/integrations/torrserver"
)

// TorrServerTorrent is the contract's TorrServerTorrent.
type TorrServerTorrent struct {
	Hash             string     `json:"hash"`
	Title            string     `json:"title"`
	SizeBytes        *int64     `json:"size_bytes"`
	Stat             int        `json:"stat"`
	StatString       string     `json:"stat_string"`
	Idle             bool       `json:"idle"`
	AddedAt          *time.Time `json:"added_at"`
	Peers            int        `json:"peers"`
	DownloadSpeedBps float64    `json:"download_speed_bps"`
	Cineko          TorrentUse `json:"martytv"`
}

// TorrentUse is what Cineko uses a torrent for.
type TorrentUse struct {
	Sources   int           `json:"sources"`
	Streaming bool          `json:"streaming"`
	Download  *DownloadUsed `json:"download"`
	InUse     bool          `json:"in_use"`
}

// DownloadUsed is the download reading a torrent (the most active one).
type DownloadUsed struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// active download states hold a torrent (removal needs force).
var holdsTorrent = map[string]bool{StatusQueued: true, StatusDownloading: true, StatusWaitingSpace: true}

var statusRank = map[string]int{StatusDownloading: 0, StatusQueued: 1, StatusWaitingSpace: 2, StatusPaused: 3, StatusFailed: 4, StatusDone: 5}

func (s *Service) usage(ctx context.Context) (map[string]int, map[string]*DownloadUsed, error) {
	sources := map[string]int{}
	rows, err := s.pool.Query(ctx, `SELECT info_hash, count(*) FROM playback_sources WHERE kind = 'torrent' AND info_hash IS NOT NULL GROUP BY info_hash`)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var h string
		var n int
		if rows.Scan(&h, &n) == nil {
			sources[h] = n
		}
	}
	rows.Close()
	dls := map[string]*DownloadUsed{}
	rows, err = s.pool.Query(ctx, `SELECT info_hash, id, status FROM downloads`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var h string
		var d DownloadUsed
		if rows.Scan(&h, &d.ID, &d.Status) == nil {
			if cur := dls[h]; cur == nil || statusRank[d.Status] < statusRank[cur.Status] {
				dls[h] = &d
			}
		}
	}
	return sources, dls, nil
}

func (s *Service) torrents(ctx context.Context) ([]TorrServerTorrent, error) {
	list, err := s.ts.List(ctx)
	if err != nil {
		return nil, err
	}
	sources, dls, err := s.usage(ctx)
	if err != nil {
		return nil, err
	}
	streaming := s.pb.StreamingHashes()
	out := make([]TorrServerTorrent, 0, len(list))
	for _, t := range list {
		h := normHash(t.Hash)
		if h == "" {
			continue
		}
		title := t.Title
		if title == "" {
			title = t.Name
		}
		it := TorrServerTorrent{Hash: h, Title: title, Stat: t.Stat, StatString: t.StatString, Idle: t.Stat >= torrserver.StatClosed,
			Peers: t.ActivePeers, DownloadSpeedBps: t.DownloadSpeed}
		if t.TorrentSize > 0 {
			sz := t.TorrentSize
			it.SizeBytes = &sz
		}
		if t.Timestamp > 0 {
			at := time.Unix(t.Timestamp, 0).UTC()
			it.AddedAt = &at
		}
		it.Cineko = TorrentUse{Sources: sources[h], Streaming: streaming[h], Download: dls[h]}
		it.Cineko.InUse = it.Cineko.Streaming || (dls[h] != nil && holdsTorrent[dls[h].Status])
		out = append(out, it)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].AddedAt, out[j].AddedAt
		switch {
		case a == nil:
			return false
		case b == nil:
			return true
		}
		return a.After(*b)
	})
	return out, nil
}

var hashRe = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)

func normHash(h string) string {
	if !hashRe.MatchString(h) {
		return ""
	}
	b := []byte(h)
	for i, c := range b {
		if c >= 'A' && c <= 'F' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func tsHTTPError(err error) error {
	if errors.Is(err, torrserver.ErrNotConfigured) {
		return httpx.NewError(fiber.StatusBadGateway, "torrserver_unavailable", "TorrServer is not configured.")
	}
	return httpx.NewError(fiber.StatusBadGateway, "torrserver_unavailable", "TorrServer is unavailable.")
}

func (s *Service) adminTorrents(c fiber.Ctx) error {
	out, err := s.torrents(c.Context())
	if err != nil {
		s.log.Warn("torrserver list", "err", err)
		return tsHTTPError(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(httpx.List(out))
}

func (s *Service) adminRemoveTorrent(c fiber.Ctx) error {
	hash := c.Params("hash")
	if !torrserver.ValidHash(hash) {
		return httpx.NotFound()
	}
	hash = strings.Clone(hash) // fiber params are reused after the handler
	force := c.Query("force") == "true" || c.Query("force") == "1"
	ctx := c.Context()
	list, err := s.torrents(ctx)
	if err != nil {
		return tsHTTPError(err)
	}
	var t *TorrServerTorrent
	for i := range list {
		if list[i].Hash == hash {
			t = &list[i]
		}
	}
	if t == nil {
		return httpx.NotFound()
	}
	if t.Cineko.InUse && !force {
		return httpx.NewError(fiber.StatusConflict, "torrent_in_use", "Cineko is streaming or downloading this torrent.")
	}
	if err := s.ts.Remove(ctx, hash); err != nil {
		s.log.Warn("torrserver remove", "err", err)
		return tsHTTPError(err)
	}
	p := auth.PrincipalFrom(c)
	s.audit.Record(ctx, audit.Event{UserID: p.UserID, Action: "torrserver.removed", TargetType: "torrent", TargetID: hash,
		IP: c.IP(), RequestID: httpx.RequestID(c),
		Metadata: map[string]any{"title": t.Title, "stat": t.StatString, "force": force, "in_use": t.Cineko.InUse}})
	return c.SendStatus(fiber.StatusNoContent)
}
