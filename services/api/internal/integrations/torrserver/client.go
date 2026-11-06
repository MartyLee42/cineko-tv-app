// Package torrserver is a minimal client for TorrServer MatriX (the
// household's existing streaming torrent engine). It only uses routes listed
// in the installed version's swagger (docs/integrations/torrserver-matrix141.swagger.json):
//
//	GET  /echo                       version string ("MatriX.141")
//	POST /torrents                   action add | get | rem | list
//	POST /torrent/upload             add a .torrent file (multipart)
//	GET  /stream?link=&index=&play   raw file bytes with HTTP Range
//	GET  /ffp/{hash}/{id}            ffprobe JSON
//
// Admin routes (/settings, /shutdown, /storage/settings…) are never called.
//
// Errors never contain the TorrServer URL or credentials: callers may log
// them, but they are still not meant for clients.
package torrserver

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"martytv/api/internal/config"
)

var (
	// ErrNotConfigured means TORRSERVER_URL is empty.
	ErrNotConfigured = errors.New("torrserver is not configured")
	// ErrUnavailable means TorrServer could not be reached or answered 5xx.
	ErrUnavailable = errors.New("torrserver is unavailable")
	// ErrUnauthorized means TorrServer rejected the configured credentials.
	ErrUnauthorized = errors.New("torrserver rejected the credentials")
	// ErrNotFound means TorrServer does not know the torrent/file.
	ErrNotFound = errors.New("torrent not found in torrserver")
	// ErrUnsupported means the installed version lacks a needed capability.
	ErrUnsupported = errors.New("torrserver version does not support this")
	// ErrBadResponse means TorrServer answered with something unexpected.
	ErrBadResponse = errors.New("unexpected torrserver response")
)

// Torrent is the subset of state.TorrentStatus we use.
type Torrent struct {
	Hash             string     `json:"hash"`
	Title            string     `json:"title"`
	Name             string     `json:"name"`
	Stat             int        `json:"stat"`
	StatString       string     `json:"stat_string"`
	TorrentSize      int64      `json:"torrent_size"`
	ActivePeers      int        `json:"active_peers"`
	TotalPeers       int        `json:"total_peers"`
	ConnectedSeeders int        `json:"connected_seeders"`
	DownloadSpeed    float64    `json:"download_speed"`
	UploadSpeed      float64    `json:"upload_speed"`
	PreloadedBytes   int64      `json:"preloaded_bytes"`
	PreloadSize      int64      `json:"preload_size"`
	FileStats        []FileStat `json:"file_stats"`
	// Timestamp: when it was added (unix seconds; list/get).
	Timestamp int64 `json:"timestamp"`
}

// Torrent states (state.TorrentStat).
const (
	StatAdded       = 0
	StatGettingInfo = 1
	StatPreload     = 2
	StatWorking     = 3
	StatClosed      = 4
	StatInDB        = 5
)

// FileStat is one file of a torrent. IDs are TorrServer's (1-based).
type FileStat struct {
	ID     int    `json:"id"`
	Path   string `json:"path"`
	Length int64  `json:"length"`
}

// HasMetadata reports whether the file list is known.
func (t *Torrent) HasMetadata() bool { return t != nil && len(t.FileStats) > 0 }

// AddRequest registers a torrent by magnet/hash link.
type AddRequest struct {
	Link     string
	Title    string
	Category string // movie | tv
	Data     string
	SaveToDB bool
}

// Client talks to one TorrServer instance.
type Client struct {
	base     *url.URL
	username string
	password string
	api      *http.Client // short JSON calls
	slow     *http.Client // ffprobe (waits for data)
	stream   *http.Client // long-lived streams: no overall timeout

	capMu   sync.Mutex
	caps    *Capabilities
	capsAt  time.Time
	capsTTL time.Duration
}

// New builds a client; it never fails (an invalid URL yields a client whose
// calls return ErrNotConfigured).
func New(cfg config.TorrServerConfig) *Client {
	c := &Client{username: cfg.Username, password: cfg.Password, capsTTL: 10 * time.Minute}
	if u, err := url.Parse(strings.TrimRight(cfg.URL, "/")); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
		u.RawQuery, u.Fragment = "", ""
		c.base = u
	}
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	tr := &http.Transport{
		Proxy:                 nil, // TorrServer is local; never route it through a proxy
		DialContext:           dialer.DialContext,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       60 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
		DisableCompression:    true,
	}
	c.api = &http.Client{Transport: tr, Timeout: 10 * time.Second, CheckRedirect: noRedirect}
	c.slow = &http.Client{Transport: tr, Timeout: 45 * time.Second, CheckRedirect: noRedirect}
	c.stream = &http.Client{Transport: tr, CheckRedirect: noRedirect}
	return c
}

// Configured reports whether a usable URL is set.
func (c *Client) Configured() bool { return c.base != nil }

func (c *Client) endpoint(path string, q url.Values) string {
	u := *c.base
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawPath = ""
	if q != nil {
		u.RawQuery = q.Encode()
	}
	return u.String()
}

func (c *Client) newRequest(ctx context.Context, method, path string, q url.Values, body io.Reader) (*http.Request, error) {
	if c.base == nil {
		return nil, ErrNotConfigured
	}
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint(path, q), body)
	if err != nil {
		return nil, ErrBadResponse
	}
	if c.username != "" || c.password != "" {
		req.SetBasicAuth(c.username, c.password)
	}
	return req, nil
}

// do runs a request and maps transport/status errors to sanitized errors.
func (c *Client) do(hc *http.Client, req *http.Request) (*http.Response, error) {
	resp, err := hc.Do(req)
	if err != nil {
		return nil, transportError(err)
	}
	if err := statusError(resp.StatusCode); err != nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		resp.Body.Close()
		return nil, err
	}
	return resp, nil
}

// transportError drops the *url.Error wrapper (it includes the URL).
func transportError(err error) error {
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%w: timeout", ErrUnavailable)
	}
	return ErrUnavailable
}

func statusError(code int) error {
	switch {
	case code == http.StatusOK || code == http.StatusPartialContent:
		return nil
	case code == http.StatusUnauthorized || code == http.StatusForbidden:
		return ErrUnauthorized
	case code == http.StatusNotFound:
		return ErrNotFound
	case code >= 500:
		return fmt.Errorf("%w: HTTP %d", ErrUnavailable, code)
	default:
		return fmt.Errorf("%w: HTTP %d", ErrBadResponse, code)
	}
}

func (c *Client) postJSON(ctx context.Context, path string, in, out any) error {
	b, _ := json.Marshal(in)
	req, err := c.newRequest(ctx, http.MethodPost, path, nil, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.do(c.api, req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out); err != nil {
		return ErrBadResponse
	}
	return nil
}

// ---- capabilities ----

// Capabilities are derived from the installed version (GET /echo) rather
// than assumed. Thresholds are conservative; MatriX.141 is verified.
type Capabilities struct {
	Version string `json:"version"`
	Matrix  int    `json:"matrix"`
	// Supported: a MatriX build with /torrents and /stream.
	Supported bool `json:"supported"`
	Upload    bool `json:"upload"`  // POST /torrent/upload
	Play      bool `json:"play"`    // GET /play/{hash}/{id}
	FFProbe   bool `json:"ffprobe"` // GET /ffp/{hash}/{id}
	Cache     bool `json:"cache"`   // POST /cache
}

var matrixVersion = regexp.MustCompile(`^MatriX\.(\d+)`)

// MinMatrix is the oldest MatriX release we accept.
const MinMatrix = 100

// CapabilitiesFor maps a version string to capabilities.
func CapabilitiesFor(version string) Capabilities {
	v := strings.TrimSpace(version)
	caps := Capabilities{Version: v}
	m := matrixVersion.FindStringSubmatch(v)
	if m == nil {
		return caps
	}
	n, _ := strconv.Atoi(m[1])
	caps.Matrix = n
	caps.Supported = n >= MinMatrix
	caps.Upload = caps.Supported
	caps.Cache = caps.Supported
	caps.Play = n >= 130
	caps.FFProbe = n >= 120
	return caps
}

// List returns the capability names that are on (for diagnostics).
func (c Capabilities) List() []string {
	var out []string
	for _, f := range []struct {
		on   bool
		name string
	}{{c.Supported, "torrents"}, {c.Supported, "stream"}, {c.Upload, "upload"}, {c.Play, "play"}, {c.FFProbe, "ffprobe"}, {c.Cache, "cache"}} {
		if f.on {
			out = append(out, f.name)
		}
	}
	return out
}

// Echo returns the raw version string from GET /echo.
func (c *Client) Echo(ctx context.Context) (string, error) {
	req, err := c.newRequest(ctx, http.MethodGet, "/echo", nil, nil)
	if err != nil {
		return "", err
	}
	resp, err := c.do(c.api, req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
	return strings.TrimSpace(string(b)), nil
}

// Capabilities detects (and caches) what the installed version supports.
func (c *Client) Capabilities(ctx context.Context) (Capabilities, error) {
	c.capMu.Lock()
	defer c.capMu.Unlock()
	if c.caps != nil && time.Since(c.capsAt) < c.capsTTL {
		return *c.caps, nil
	}
	v, err := c.Echo(ctx)
	if err != nil {
		return Capabilities{}, err
	}
	caps := CapabilitiesFor(v)
	c.caps, c.capsAt = &caps, time.Now()
	return caps, nil
}

// requireSupported returns ErrUnsupported for non-MatriX servers.
func (c *Client) requireSupported(ctx context.Context) (Capabilities, error) {
	caps, err := c.Capabilities(ctx)
	if err != nil {
		return caps, err
	}
	if !caps.Supported {
		return caps, ErrUnsupported
	}
	return caps, nil
}

// ---- torrents ----

// Add registers a torrent by magnet link or info hash.
func (c *Client) Add(ctx context.Context, r AddRequest) (*Torrent, error) {
	if _, err := c.requireSupported(ctx); err != nil {
		return nil, err
	}
	var t Torrent
	err := c.postJSON(ctx, "/torrents", map[string]any{
		"action": "add", "link": r.Link, "title": r.Title, "category": r.Category,
		"data": r.Data, "save_to_db": r.SaveToDB,
	}, &t)
	if err != nil {
		return nil, err
	}
	return normalize(&t)
}

// Upload registers a .torrent file.
func (c *Client) Upload(ctx context.Context, torrent []byte, r AddRequest) (*Torrent, error) {
	caps, err := c.requireSupported(ctx)
	if err != nil {
		return nil, err
	}
	if !caps.Upload {
		return nil, ErrUnsupported
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "release.torrent")
	_, _ = fw.Write(torrent)
	_ = mw.WriteField("save", strconv.FormatBool(r.SaveToDB))
	_ = mw.WriteField("title", r.Title)
	_ = mw.WriteField("category", r.Category)
	_ = mw.WriteField("data", r.Data)
	_ = mw.Close()
	req, err := c.newRequest(ctx, http.MethodPost, "/torrent/upload", nil, &buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := c.do(c.api, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var t Torrent
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&t); err != nil {
		return nil, ErrBadResponse
	}
	return normalize(&t)
}

// Get returns a torrent's status and file list (activating it if it is only
// stored in TorrServer's DB).
func (c *Client) Get(ctx context.Context, hash string) (*Torrent, error) {
	if !ValidHash(hash) {
		return nil, ErrNotFound
	}
	var t Torrent
	if err := c.postJSON(ctx, "/torrents", map[string]any{"action": "get", "hash": hash}, &t); err != nil {
		return nil, err
	}
	if t.Hash == "" {
		return nil, ErrNotFound
	}
	return normalize(&t)
}

// List returns all torrents.
func (c *Client) List(ctx context.Context) ([]Torrent, error) {
	var ts []Torrent
	if err := c.postJSON(ctx, "/torrents", map[string]any{"action": "list"}, &ts); err != nil {
		return nil, err
	}
	return ts, nil
}

// Remove deletes a torrent from TorrServer (and its DB).
func (c *Client) Remove(ctx context.Context, hash string) error {
	if !ValidHash(hash) {
		return ErrNotFound
	}
	return c.postJSON(ctx, "/torrents", map[string]any{"action": "rem", "hash": hash}, nil)
}

func normalize(t *Torrent) (*Torrent, error) {
	t.Hash = strings.ToLower(strings.TrimSpace(t.Hash))
	if !ValidHash(t.Hash) {
		return nil, ErrBadResponse
	}
	return t, nil
}

var hashPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

// ValidHash reports whether h is a lowercase hex v1 info hash.
func ValidHash(h string) bool { return hashPattern.MatchString(h) }

// ---- ffprobe ----

// Probe is the part of ffprobe's JSON we use.
type Probe struct {
	Streams []struct {
		Index       int               `json:"index"`
		CodecName   string            `json:"codec_name"`
		CodecType   string            `json:"codec_type"`
		Width       int               `json:"width"`
		Height      int               `json:"height"`
		Channels    int               `json:"channels"`
		Profile     string            `json:"profile"`
		PixFmt      string            `json:"pix_fmt"`
		Level       int               `json:"level"`
		// BitsPerRawSample: ffprobe prints it as a string ("10").
		BitsPerRawSample string `json:"bits_per_raw_sample"`
		FieldOrder       string `json:"field_order"`
		// MimeCodec: the RFC 6381 codec string (newer ffprobe only), e.g. "avc1.6e0028".
		MimeCodec string `json:"mime_codec_string"`
		Disposition map[string]int    `json:"disposition"`
		Tags        map[string]string `json:"tags"`
	} `json:"streams"`
	Format struct {
		FormatName string `json:"format_name"`
		Duration   string `json:"duration"`
	} `json:"format"`
}

// FFProbe runs TorrServer's ffprobe on one file (GET /ffp/{hash}/{id}). It
// may take a while: TorrServer must download the file's headers first.
func (c *Client) FFProbe(ctx context.Context, hash string, id int) (*Probe, error) {
	caps, err := c.requireSupported(ctx)
	if err != nil {
		return nil, err
	}
	if !caps.FFProbe {
		return nil, ErrUnsupported
	}
	if !ValidHash(hash) || id < 0 {
		return nil, ErrNotFound
	}
	req, err := c.newRequest(ctx, http.MethodGet, "/ffp/"+hash+"/"+strconv.Itoa(id), nil, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.do(c.slow, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var p Probe
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&p); err != nil {
		return nil, ErrBadResponse
	}
	return &p, nil
}

// ---- streaming ----

// StreamInput is the /stream URL for hash/id plus the Authorization header
// value TorrServer needs, for a trusted reader on the internal network (the
// compat transcoder). Never return either to clients or log them.
func (c *Client) StreamInput(hash string, id int) (streamURL, authorization string, err error) {
	if c.base == nil {
		return "", "", ErrNotConfigured
	}
	if !ValidHash(hash) || id < 0 {
		return "", "", ErrNotFound
	}
	q := url.Values{}
	q.Set("link", hash)
	q.Set("index", strconv.Itoa(id))
	q.Set("play", "")
	if c.username != "" || c.password != "" {
		authorization = "Basic " + base64.StdEncoding.EncodeToString([]byte(c.username+":"+c.password))
	}
	return c.endpoint("/stream", q), authorization, nil
}

// Stream opens GET /stream?link=<hash>&index=<id>&play, forwarding only the
// given range headers. The caller must close the body. hash and id always
// come from the server's own records, never from a client.
func (c *Client) Stream(ctx context.Context, hash string, id int, rangeHdr, ifRange string) (*http.Response, error) {
	if !ValidHash(hash) || id < 0 {
		return nil, ErrNotFound
	}
	q := url.Values{}
	q.Set("link", hash)
	q.Set("index", strconv.Itoa(id))
	q.Set("play", "")
	req, err := c.newRequest(ctx, http.MethodGet, "/stream", q, nil)
	if err != nil {
		return nil, err
	}
	if rangeHdr != "" {
		req.Header.Set("Range", rangeHdr)
	}
	if ifRange != "" {
		req.Header.Set("If-Range", ifRange)
	}
	resp, err := c.stream.Do(req)
	if err != nil {
		return nil, transportError(err)
	}
	if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		return resp, nil
	}
	if err := statusError(resp.StatusCode); err != nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		resp.Body.Close()
		return nil, err
	}
	return resp, nil
}
