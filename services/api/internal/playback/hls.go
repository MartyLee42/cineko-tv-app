package playback

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// HLS proxy for online sources.
//
// Every URI inside an upstream playlist (variant playlists, segments, keys,
// EXT-X-MAP, EXT-X-MEDIA renditions…) is rewritten to
//
//	/api/v1/stream/<token>/<b64url(upstream url)>.<b64url(mac)>.<ext>
//
// where mac = HMAC(key, source id | upstream url) truncated to 16 bytes. The
// proxy fetches only URLs carrying a valid mac for the token's source: i.e.
// URLs the provider gave us or that appeared in a playlist we fetched for
// that source. Anything else is refused (no open proxy). Upstream hosts must
// resolve to public addresses (checked at dial time, also after redirects).

const (
	maxPlaylistBytes = 2 << 20
	maxProxiedURL    = 2048
	upstreamTimeout  = 15 * time.Second
	hlsMime          = "application/vnd.apple.mpegurl"
)

var (
	errBadProxyRef   = errors.New("invalid proxied url")
	errBlockedTarget = errors.New("upstream address not allowed")
)

// urlSigner signs upstream URLs for one source.
type urlSigner struct{ key []byte }

func newURLSigner(secret []byte) *urlSigner {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("martytv/playback/hls-url/v1"))
	return &urlSigner{key: m.Sum(nil)}
}

func (s *urlSigner) mac(sourceID, u string) []byte {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte(sourceID))
	m.Write([]byte{0})
	m.Write([]byte(u))
	return m.Sum(nil)[:16]
}

// ref builds the path segment for an upstream URL.
func (s *urlSigner) ref(sourceID, u string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(u)) + "." +
		base64.RawURLEncoding.EncodeToString(s.mac(sourceID, u)) + "." + refExt(u)
}

// refExt is the URL's extension for a ref (players sniff it), else "bin".
func refExt(u string) string {
	ext := strings.TrimPrefix(path.Ext(pathOf(u)), ".")
	if !safeExt.MatchString(ext) {
		return "bin"
	}
	return strings.ToLower(ext)
}

var safeExt = regexp.MustCompile(`^[A-Za-z0-9]{1,5}$`)

// open verifies a path segment and returns the upstream URL.
func (s *urlSigner) open(sourceID, seg string) (string, error) {
	if len(seg) > maxProxiedURL*2 {
		return "", errBadProxyRef
	}
	parts := strings.Split(seg, ".")
	if len(parts) != 3 {
		return "", errBadProxyRef
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(raw) == 0 || len(raw) > maxProxiedURL {
		return "", errBadProxyRef
	}
	sum, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(sum, s.mac(sourceID, string(raw))) {
		return "", errBadProxyRef
	}
	u := string(raw)
	if _, err := upstreamURL(u); err != nil {
		return "", err
	}
	return u, nil
}

func pathOf(u string) string {
	if p, err := url.Parse(u); err == nil {
		return p.Path
	}
	return u
}

// upstreamURL accepts only absolute http(s) URLs without credentials.
func upstreamURL(u string) (*url.URL, error) {
	p, err := url.Parse(u)
	if err != nil || (p.Scheme != "http" && p.Scheme != "https") || p.Host == "" || p.User != nil {
		return nil, errBadProxyRef
	}
	return p, nil
}

var uriAttr = regexp.MustCompile(`URI="([^"]*)"`)

// rewritePlaylist rewrites every URI in an M3U8 (master or media) so it
// goes through the proxy. base is the playlist's own (final) URL; mk maps
// an absolute upstream URL to the client-visible URL. Lines whose URI
// cannot be resolved to http(s) are dropped.
func rewritePlaylist(body []byte, base *url.URL, mk func(abs string) string) ([]byte, error) {
	if !bytes.HasPrefix(bytes.TrimLeft(bytes.TrimPrefix(body, []byte("\xef\xbb\xbf")), " \t\r\n"), []byte("#EXTM3U")) {
		return nil, errors.New("not an m3u8 playlist")
	}
	resolve := func(ref string) (string, bool) {
		r, err := url.Parse(strings.TrimSpace(ref))
		if err != nil {
			return "", false
		}
		abs := base.ResolveReference(r)
		if abs.Scheme != "http" && abs.Scheme != "https" {
			return "", false
		}
		abs.Fragment = ""
		return abs.String(), true
	}
	var out bytes.Buffer
	sc := bufio.NewScanner(bytes.NewReader(body))
	sc.Buffer(make([]byte, 64<<10), maxPlaylistBytes)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "":
			out.WriteString("\n")
			continue
		case strings.HasPrefix(trimmed, "#"):
			if strings.HasPrefix(trimmed, "#EXT") && strings.Contains(trimmed, `URI="`) {
				ok := true
				line = uriAttr.ReplaceAllStringFunc(trimmed, func(m string) string {
					ref := uriAttr.FindStringSubmatch(m)[1]
					if strings.HasPrefix(ref, "data:") || strings.HasPrefix(ref, "skd:") {
						return m // inline / DRM key ids stay as they are
					}
					abs, good := resolve(ref)
					if !good {
						ok = false
						return m
					}
					return `URI="` + mk(abs) + `"`
				})
				if !ok {
					continue // never pass through a URI we could not proxy
				}
			}
			out.WriteString(line)
		default:
			abs, ok := resolve(trimmed)
			if !ok {
				continue
			}
			out.WriteString(mk(abs))
		}
		out.WriteString("\n")
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// isPlaylist reports whether an upstream response is an M3U8.
func isPlaylist(contentType, u string) bool {
	ct := strings.ToLower(contentType)
	return strings.Contains(ct, "mpegurl") || strings.HasSuffix(strings.ToLower(pathOf(u)), ".m3u8")
}

// newUpstreamClient builds the HTTP client for CDN fetches: dials only
// public addresses (unless allowPrivate, for tests), at most 3 redirects,
// response headers within upstreamTimeout. Body reads are bounded by the
// caller (idle reader / playlist cap).
func newUpstreamClient(allowPrivate bool) *http.Client {
	return newUpstreamClientT(allowPrivate, 10*time.Second, upstreamTimeout)
}

// newUpstreamClientT is newUpstreamClient with its own dial/TLS and
// response-header timeouts (live channels fail fast).
func newUpstreamClientT(allowPrivate bool, dial, header time.Duration) *http.Client {
	d := &net.Dialer{Timeout: dial, KeepAlive: 30 * time.Second}
	if !allowPrivate {
		d.Control = func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return errBlockedTarget
			}
			ip := net.ParseIP(host)
			if ip == nil || !publicIP(ip) {
				return errBlockedTarget
			}
			return nil
		}
	}
	tr := &http.Transport{
		Proxy:                 nil,
		DialContext:           d.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   header,
		ResponseHeaderTimeout: header,
	}
	return &http.Client{
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errBlockedTarget
			}
			return nil
		},
	}
}

func publicIP(ip net.IP) bool {
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast() ||
		cgnat.Contains(ip))
}

var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

// fetchPlaylist GETs an upstream playlist (≤ maxPlaylistBytes) and returns
// the body, the final URL (after redirects) and the status.
func fetchPlaylist(ctx context.Context, hc *http.Client, u string, headers map[string]string) ([]byte, *url.URL, int, error) {
	ctx, cancel := context.WithTimeout(ctx, upstreamTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, nil, 0, err
	}
	setUpstreamHeaders(req, headers)
	resp, err := hc.Do(req)
	if err != nil {
		return nil, nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusPartialContent {
		resp.StatusCode = http.StatusOK // some servers answer a plain GET with 206 (the whole body)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, nil, resp.StatusCode, nil
	}
	var buf bytes.Buffer
	n, err := buf.ReadFrom(io.LimitReader(resp.Body, maxPlaylistBytes+1))
	if err != nil || n == 0 || n > maxPlaylistBytes {
		return nil, nil, resp.StatusCode, errors.New("playlist read failed")
	}
	return buf.Bytes(), resp.Request.URL, resp.StatusCode, nil
}

func setUpstreamHeaders(req *http.Request, headers map[string]string) {
	req.Header.Set("User-Agent", "Mozilla/5.0 (Cineko)")
	for k, v := range headers {
		switch http.CanonicalHeaderKey(k) {
		case "Referer", "Origin", "User-Agent", "Cookie", "Authorization":
			req.Header.Set(k, v)
		}
	}
}

var (
	reAttrType    = regexp.MustCompile(`(?:^|[:,])TYPE=([A-Z-]+)`)
	reAttrGroup   = regexp.MustCompile(`(?:^|[:,])GROUP-ID="([^"]*)"`)
	reAttrDefault = regexp.MustCompile(`([:,])DEFAULT=(?:YES|NO)`)
	reAttrAuto    = regexp.MustCompile(`([:,])AUTOSELECT=(?:YES|NO)`)
)

// keepAudio reduces every TYPE=AUDIO group of a master playlist to its
// n-th rendition (1-based, in playlist order), marked DEFAULT and
// AUTOSELECT, so a multi-audio stream (Collaps: one rendition per voice)
// plays the chosen voice on engines that can't switch HLS audio tracks.
// A group with fewer than n renditions is left as it is; media playlists
// and n < 1 pass through unchanged.
func keepAudio(body []byte, n int) []byte {
	if n < 1 || !bytes.Contains(body, []byte("#EXT-X-MEDIA:")) {
		return body
	}
	lines := strings.Split(string(body), "\n")
	audioGroup := func(line string) (string, bool) {
		t := strings.TrimSpace(line)
		if !strings.HasPrefix(t, "#EXT-X-MEDIA:") {
			return "", false
		}
		m := reAttrType.FindStringSubmatch(t)
		if m == nil || m[1] != "AUDIO" {
			return "", false
		}
		g := reAttrGroup.FindStringSubmatch(t)
		if g == nil {
			return "", true
		}
		return g[1], true
	}
	size := map[string]int{}
	for _, l := range lines {
		if g, ok := audioGroup(l); ok {
			size[g]++
		}
	}
	seen := map[string]int{}
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		g, ok := audioGroup(l)
		if !ok || size[g] < n {
			out = append(out, l)
			continue
		}
		seen[g]++
		if seen[g] != n {
			continue
		}
		t := strings.TrimRight(l, "\r")
		if reAttrDefault.MatchString(t) {
			t = reAttrDefault.ReplaceAllString(t, "${1}DEFAULT=YES")
		} else {
			t += ",DEFAULT=YES"
		}
		if reAttrAuto.MatchString(t) {
			t = reAttrAuto.ReplaceAllString(t, "${1}AUTOSELECT=YES")
		} else {
			t += ",AUTOSELECT=YES"
		}
		out = append(out, t)
	}
	return []byte(strings.Join(out, "\n"))
}
