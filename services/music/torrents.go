package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
)

// Lossless / alternative playback from torrents: Prowlarr finds releases
// (RU trackers; text search only, categories are unreliable there),
// TorrServer streams the files. Prowlarr links carry the API key, so
// releases stay on the server and clients only see an opaque id.

type Torrents struct {
	prowlarr    string
	prowlarrKey string
	torr        string
	torrAuth    string
	api         *http.Client
	stream      *http.Client

	mu       sync.Mutex
	releases map[string]cachedRelease
}

type cachedRelease struct {
	r  prowlarrRelease
	at time.Time
}

type prowlarrRelease struct {
	GUID        string `json:"guid"`
	Title       string `json:"title"`
	Size        int64  `json:"size"`
	Seeders     *int   `json:"seeders"`
	Leechers    *int   `json:"leechers"`
	Indexer     string `json:"indexer"`
	InfoHash    string `json:"infoHash"`
	MagnetURL   string `json:"magnetUrl"`
	DownloadURL string `json:"downloadUrl"`
	PublishDate string `json:"publishDate"`
	Protocol    string `json:"protocol"`
	Categories  []struct {
		ID int `json:"id"`
	} `json:"categories"`
}

var (
	errTorrNotConfigured = errors.New("torrents are not configured")
	errTorrNotFound      = errors.New("torrent not found")
	errReleaseGone       = errors.New("search result expired, search again")
	errTorrNoMetadata    = errors.New("torrent has no metadata yet (no peers?)")
)

func newTorrents(cfg config) *Torrents {
	t := &Torrents{prowlarr: cfg.ProwlarrURL, prowlarrKey: cfg.ProwlarrKey, torr: cfg.TorrURL, releases: map[string]cachedRelease{}}
	if cfg.TorrUser != "" || cfg.TorrPass != "" {
		t.torrAuth = "Basic " + base64.StdEncoding.EncodeToString([]byte(cfg.TorrUser+":"+cfg.TorrPass))
	}
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	tr := &http.Transport{Proxy: nil, MaxIdleConnsPerHost: 8, IdleConnTimeout: 60 * time.Second, ResponseHeaderTimeout: 60 * time.Second, DisableCompression: true}
	t.api = &http.Client{Transport: tr, Timeout: 40 * time.Second, CheckRedirect: noRedirect}
	t.stream = &http.Client{Transport: tr, CheckRedirect: noRedirect}
	return t
}

func (t *Torrents) SearchConfigured() bool {
	return t.prowlarr != "" && t.prowlarrKey != "" && t.torr != ""
}
func (t *Torrents) Configured() bool { return t.torr != "" }

// ---- release search ----

// Release is a search result as clients see it.
type Release struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Size        int64   `json:"size"`
	Seeders     int     `json:"seeders"`
	Leechers    int     `json:"leechers"`
	Indexer     string  `json:"indexer"`
	Format      string  `json:"format"`
	Lossless    bool    `json:"lossless"`
	Discography bool    `json:"discography"`
	Date        string  `json:"date,omitempty"`
	Score       float64 `json:"score"`
}

var (
	reLossless = regexp.MustCompile(`(?i)\b(flac|alac|ape|wavpack|wv|lossless|hi-?res|24[ -]?bit|dsd|dsf|sacd|wav)\b`)
	reLossy    = regexp.MustCompile(`(?i)\b(mp3|aac|m4a|ogg|opus|vorbis|\d{3}\s?kbps|vbr|cbr|320)\b`)
	reMusic    = regexp.MustCompile(`(?i)(дискография|discography|альбом|album|\bep\b|single|сингл|сборник|compilation|ost|soundtrack|tracks|\.cue|image\+\.?cue|\bcd\b|vinyl|винил)`)
	reVideo    = regexp.MustCompile(`(?i)\b(bdrip|webrip|web-?dl|hdtv|hdrip|dvdrip|dvd[59]?|1080[pi]|720p|2160p|4k|x26[45]|h\.?26[45]|hevc|avc|remux|blu-?ray|bdremux|xvid|divx|сезон|серии|серия|season|episode|mkv|avi|клипы|концерт.*(dvd|bd)|video)\b`)
	reDisco    = regexp.MustCompile(`(?i)(дискография|discography|collection|коллекция|антология|anthology|\d{4}\s*-\s*\d{4})`)
)

func detectFormat(title string) (string, bool) {
	t := strings.ToLower(title)
	switch {
	case strings.Contains(t, "flac"):
		if strings.Contains(t, "24") && (strings.Contains(t, "bit") || strings.Contains(t, "бит")) {
			return "FLAC 24bit", true
		}
		return "FLAC", true
	case strings.Contains(t, "alac"):
		return "ALAC", true
	case regexp.MustCompile(`\bape\b`).MatchString(t):
		return "APE", true
	case strings.Contains(t, "wavpack") || regexp.MustCompile(`\bwv\b`).MatchString(t):
		return "WavPack", true
	case strings.Contains(t, "dsd") || strings.Contains(t, "dsf") || strings.Contains(t, "sacd"):
		return "DSD", true
	case strings.Contains(t, "lossless") || strings.Contains(t, "hi-res") || strings.Contains(t, "hires"):
		return "Lossless", true
	case strings.Contains(t, "mp3"):
		if strings.Contains(t, "320") {
			return "MP3 320", false
		}
		return "MP3", false
	case strings.Contains(t, "aac") || strings.Contains(t, "m4a"):
		return "AAC", false
	case strings.Contains(t, "ogg") || strings.Contains(t, "opus"):
		return "OGG", false
	}
	return "", false
}

func (t *Torrents) prowlarrSearch(ctx context.Context, q string) ([]prowlarrRelease, error) {
	u := t.prowlarr + "/api/v1/search?" + url.Values{"query": {q}, "type": {"search"}, "limit": {"100"}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Api-Key", t.prowlarrKey)
	req.Header.Set("Accept", "application/json")
	resp, err := t.api.Do(req)
	if err != nil {
		return nil, fmt.Errorf("prowlarr: %w", shortErr(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusBadRequest {
		return nil, errors.New("prowlarr: all indexers unavailable")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("prowlarr: HTTP %d", resp.StatusCode)
	}
	var out []prowlarrRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&out); err != nil {
		return nil, fmt.Errorf("prowlarr: decode: %w", err)
	}
	return out, nil
}

// Search finds music releases. artist/album (optional) steer the scoring;
// q is the free text sent to the trackers.
func (t *Torrents) Search(ctx context.Context, queries []string, artist, album string) ([]Release, error) {
	if !t.SearchConfigured() {
		return nil, errTorrNotConfigured
	}
	// Prowlarr fans out to every tracker; RuTracker can take ~30 s.
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	var mu sync.Mutex
	var wg sync.WaitGroup
	all := []prowlarrRelease{}
	var lastErr error
	for _, q := range queries {
		if strings.TrimSpace(q) == "" {
			continue
		}
		wg.Add(1)
		go func(q string) {
			defer wg.Done()
			rs, err := t.prowlarrSearch(ctx, q)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				lastErr = err
				return
			}
			all = append(all, rs...)
		}(q)
	}
	wg.Wait()
	if len(all) == 0 && lastErr != nil {
		return nil, lastErr
	}
	nArtist, nAlbum := normalize(artist), normalize(album)
	seen := map[string]bool{}
	out := []Release{}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pruneLocked()
	for _, r := range all {
		if r.Protocol != "" && r.Protocol != "torrent" {
			continue
		}
		key := r.GUID
		if r.InfoHash != "" {
			key = strings.ToLower(r.InfoHash)
		}
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		title := r.Title
		music := reLossless.MatchString(title) || reLossy.MatchString(title) || reMusic.MatchString(title)
		for _, c := range r.Categories {
			if c.ID >= 3000 && c.ID < 4000 {
				music = true
			}
		}
		if !music || (reVideo.MatchString(title) && !reLossless.MatchString(title) && !reLossy.MatchString(title)) {
			continue
		}
		nt := normalize(title)
		score := 0.0
		if nArtist != "" {
			if !strings.Contains(nt, nArtist) {
				continue
			}
			score += 20
		}
		disco := reDisco.MatchString(title)
		if nAlbum != "" {
			if strings.Contains(nt, nAlbum) {
				score += 40
			} else if !disco {
				score -= 15
			}
		}
		format, lossless := detectFormat(title)
		if lossless {
			score += 10
		} else if format != "" {
			score += 5
		}
		seeders := 0
		if r.Seeders != nil {
			seeders = *r.Seeders
		}
		leechers := 0
		if r.Leechers != nil {
			leechers = *r.Leechers
		}
		if seeders == 0 {
			score -= 30
		} else {
			score += math.Min(25, 8*math.Log10(float64(seeders)+1))
		}
		if disco {
			score -= 5 // big; fine but a single album starts faster
		}
		id := randomID()
		t.releases[id] = cachedRelease{r: r, at: time.Now()}
		date := ""
		if len(r.PublishDate) >= 10 {
			date = r.PublishDate[:10]
		}
		out = append(out, Release{ID: id, Title: title, Size: r.Size, Seeders: seeders, Leechers: leechers, Indexer: r.Indexer,
			Format: format, Lossless: lossless, Discography: disco, Date: date, Score: score})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > 60 {
		out = out[:60]
	}
	return out, nil
}

func (t *Torrents) pruneLocked() {
	if len(t.releases) < 5000 {
		return
	}
	for k, v := range t.releases {
		if time.Since(v.at) > 3*time.Hour {
			delete(t.releases, k)
		}
	}
}

func randomID() string {
	b := make([]byte, 9)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ---- TorrServer ----

type tsFile struct {
	ID     int    `json:"id"`
	Path   string `json:"path"`
	Length int64  `json:"length"`
}

type tsTorrent struct {
	Hash             string   `json:"hash"`
	Title            string   `json:"title"`
	Stat             int      `json:"stat"`
	ActivePeers      int      `json:"active_peers"`
	TotalPeers       int      `json:"total_peers"`
	ConnectedSeeders int      `json:"connected_seeders"`
	DownloadSpeed    float64  `json:"download_speed"`
	FileStats        []tsFile `json:"file_stats"`
}

var hashRe = regexp.MustCompile(`^[0-9a-f]{40}$`)

func validHash(h string) bool { return hashRe.MatchString(h) }

func (t *Torrents) tsPost(ctx context.Context, path string, in any, out any) error {
	b, _ := json.Marshal(in)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.torr+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if t.torrAuth != "" {
		req.Header.Set("Authorization", t.torrAuth)
	}
	resp, err := t.api.Do(req)
	if err != nil {
		return fmt.Errorf("torrserver: %w", shortErr(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return errTorrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("torrserver: HTTP %d", resp.StatusCode)
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
}

func (t *Torrents) tsAdd(ctx context.Context, magnet, title string) (*tsTorrent, error) {
	var tt tsTorrent
	err := t.tsPost(ctx, "/torrents", map[string]any{"action": "add", "link": magnet, "title": title, "category": "music", "save_to_db": false}, &tt)
	if err != nil {
		return nil, err
	}
	tt.Hash = strings.ToLower(tt.Hash)
	if !validHash(tt.Hash) {
		return nil, errors.New("torrserver: bad add response")
	}
	return &tt, nil
}

func (t *Torrents) tsUpload(ctx context.Context, torrent []byte, title string) (*tsTorrent, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "release.torrent")
	_, _ = fw.Write(torrent)
	_ = mw.WriteField("save", "false")
	_ = mw.WriteField("title", title)
	_ = mw.WriteField("category", "music")
	_ = mw.Close()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.torr+"/torrent/upload", &buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if t.torrAuth != "" {
		req.Header.Set("Authorization", t.torrAuth)
	}
	resp, err := t.api.Do(req)
	if err != nil {
		return nil, fmt.Errorf("torrserver: %w", shortErr(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("torrserver upload: HTTP %d", resp.StatusCode)
	}
	var tt tsTorrent
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&tt); err != nil {
		return nil, err
	}
	tt.Hash = strings.ToLower(tt.Hash)
	if !validHash(tt.Hash) {
		return nil, errors.New("torrserver: bad upload response")
	}
	return &tt, nil
}

func (t *Torrents) tsGet(ctx context.Context, hash string) (*tsTorrent, error) {
	var tt tsTorrent
	if err := t.tsPost(ctx, "/torrents", map[string]any{"action": "get", "hash": hash}, &tt); err != nil {
		return nil, err
	}
	if tt.Hash == "" {
		return nil, errTorrNotFound
	}
	return &tt, nil
}

// fetchRelease downloads a release's .torrent (or magnet) from Prowlarr.
func (t *Torrents) fetchRelease(ctx context.Context, r prowlarrRelease) (magnet string, torrent []byte, err error) {
	if strings.HasPrefix(strings.ToLower(r.MagnetURL), "magnet:") {
		return r.MagnetURL, nil, nil
	}
	if r.InfoHash != "" && validHash(strings.ToLower(r.InfoHash)) && r.DownloadURL == "" && r.MagnetURL == "" {
		return "magnet:?xt=urn:btih:" + strings.ToLower(r.InfoHash), nil, nil
	}
	link := firstNonEmpty(r.DownloadURL, r.MagnetURL)
	base, _ := url.Parse(t.prowlarr)
	u, err := url.Parse(link)
	if err != nil || base == nil || !strings.EqualFold(u.Host, base.Host) {
		if r.InfoHash != "" {
			return "magnet:?xt=urn:btih:" + strings.ToLower(r.InfoHash), nil, nil
		}
		return "", nil, errors.New("release has no usable link")
	}
	for hop := 0; hop < 3; hop++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return "", nil, err
		}
		req.Header.Set("Accept", "application/x-bittorrent, */*")
		resp, err := t.api.Do(req)
		if err != nil {
			return "", nil, fmt.Errorf("release download: %w", shortErr(err))
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			loc := resp.Header.Get("Location")
			resp.Body.Close()
			if strings.HasPrefix(strings.ToLower(loc), "magnet:") {
				return loc, nil, nil
			}
			next, err := u.Parse(loc)
			if err != nil || !strings.EqualFold(next.Host, base.Host) {
				return "", nil, errors.New("release redirect off Prowlarr")
			}
			u = next
			continue
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20+1))
		resp.Body.Close()
		if err != nil {
			return "", nil, err
		}
		if resp.StatusCode != http.StatusOK {
			return "", nil, fmt.Errorf("release download: HTTP %d", resp.StatusCode)
		}
		trimmed := bytes.TrimSpace(body)
		if bytes.HasPrefix(bytes.ToLower(trimmed), []byte("magnet:")) {
			return string(trimmed), nil, nil
		}
		if len(body) > 0 && body[0] == 'd' && bytes.Contains(body, []byte("4:info")) && len(body) <= 8<<20 {
			return "", body, nil
		}
		return "", nil, errors.New("release download: not a torrent")
	}
	return "", nil, errors.New("release download: too many redirects")
}

// Open adds a search result to TorrServer and remembers it.
func (t *Torrents) Open(ctx context.Context, st *Store, id string) (string, error) {
	t.mu.Lock()
	cr, ok := t.releases[id]
	t.mu.Unlock()
	if !ok {
		return "", errReleaseGone
	}
	magnet, torrent, err := t.fetchRelease(ctx, cr.r)
	if err != nil {
		return "", err
	}
	title := cr.r.Title
	var tt *tsTorrent
	if torrent != nil {
		tt, err = t.tsUpload(ctx, torrent, title)
	} else {
		tt, err = t.tsAdd(ctx, magnet, title)
	}
	if err != nil {
		return "", err
	}
	if err := st.PutTorrent(ctx, torrentRow{Hash: tt.Hash, Title: title, Magnet: magnet, Torrent: torrent}); err != nil {
		return "", err
	}
	return tt.Hash, nil
}

// ensure returns the torrent's TorrServer state, re-adding it (it is not
// saved in TorrServer's DB, so a TorrServer restart forgets it).
func (t *Torrents) ensure(ctx context.Context, row *torrentRow) (*tsTorrent, error) {
	tt, err := t.tsGet(ctx, row.Hash)
	if err == nil {
		return tt, nil
	}
	// Any error (unknown hash, empty answer): add it again.
	if len(row.Torrent) > 0 {
		return t.tsUpload(ctx, row.Torrent, row.Title)
	}
	magnet := row.Magnet
	if magnet == "" {
		magnet = "magnet:?xt=urn:btih:" + row.Hash
	}
	return t.tsAdd(ctx, magnet, row.Title)
}

// ---- files ----

var audioExts = map[string]bool{"flac": true, "mp3": true, "m4a": true, "aac": true, "ogg": true, "opus": true, "wav": true,
	"ape": true, "wv": true, "alac": true, "aif": true, "aiff": true, "dsf": true, "dff": true, "wma": true, "mpc": true, "tta": true}

var losslessExts = map[string]bool{"flac": true, "wav": true, "ape": true, "wv": true, "alac": true, "aif": true, "aiff": true, "dsf": true, "dff": true, "tta": true}

// nativeExts play directly in modern browsers (others are transcoded).
var nativeExts = map[string]bool{"flac": true, "mp3": true, "m4a": true, "aac": true, "ogg": true, "opus": true, "wav": true}

func extOf(p string) string { return strings.TrimPrefix(strings.ToLower(path.Ext(p)), ".") }

// TorrentTrack is a playable file (or CUE track) of an opened torrent.
type TorrentTrack struct {
	Track
	Dir    string `json:"dir"`
	Number int    `json:"number,omitempty"`
	Size   int64  `json:"size,omitempty"`
	Native bool   `json:"native"`
}

type TorrentInfo struct {
	Hash    string         `json:"hash"`
	Title   string         `json:"title"`
	Ready   bool           `json:"ready"`
	Peers   int            `json:"peers"`
	Seeders int            `json:"seeders"`
	Speed   float64        `json:"speed"`
	Tracks  []TorrentTrack `json:"tracks"`
	Matched []*Track       `json:"matched,omitempty"` // aligned with the album's tracks
}

var (
	reLeadNum  = regexp.MustCompile(`^\s*(?:(?:cd|disc|диск)\s*\d+\s*[-._ ]\s*)?(\d{1,2}[-.])?(\d{1,3})\s*(?:[-._)\]]+\s*|\s+)`)
	reBrackets = regexp.MustCompile(`^\s*(\([^)]*\)|\[[^\]]*\])\s*`)
	reYearTail = regexp.MustCompile(`\s*[-–(\[]*\s*(19|20)\d{2}\s*[)\]]?\s*$`)
	reTags     = regexp.MustCompile(`\s*(\[[^\]]*\]|\(\s*(19|20)\d{2}\s*\))\s*`)
	reYearHead = regexp.MustCompile(`^\s*[(\[]?(19|20)\d{2}[)\]]?\s*[-–.]?\s*`)
)

// parseFileTitle turns "03 - Кино - Звезда по имени Солнце.flac" into (3, "Звезда по имени Солнце").
func parseFileTitle(name, artist string) (int, string) {
	base := strings.TrimSuffix(name, path.Ext(name))
	num := 0
	if m := reLeadNum.FindStringSubmatch(base); m != nil {
		num, _ = strconv.Atoi(m[2])
		base = base[len(m[0]):]
	}
	if artist != "" {
		if i := strings.Index(base, " - "); i > 0 && normalize(base[:i]) == normalize(artist) {
			base = base[i+3:]
		}
	}
	base = strings.ReplaceAll(base, "_", " ")
	return num, strings.TrimSpace(base)
}

// releaseArtistAlbum guesses artist/album from a tracker title like
// "(Rock) [CD] Кино - Группа крови - 1988, FLAC (tracks+.cue), lossless".
func releaseArtistAlbum(title string) (string, string) {
	s := title
	for {
		m := reBrackets.FindString(s)
		if m == "" {
			break
		}
		s = s[len(m):]
	}
	if i := strings.Index(s, ","); i > 0 {
		s = s[:i]
	}
	parts := strings.Split(s, " - ")
	if len(parts) < 2 {
		return strings.TrimSpace(s), ""
	}
	artist := strings.TrimSpace(parts[0])
	album := reTags.ReplaceAllString(parts[1], " ")
	album = strings.TrimSpace(reYearTail.ReplaceAllString(strings.TrimSpace(album), ""))
	return artist, album
}

func dirAlbum(dir string) string {
	b := path.Base(dir)
	if b == "." || b == "/" {
		return ""
	}
	b = reYearHead.ReplaceAllString(b, "")
	b = reYearTail.ReplaceAllString(b, "")
	for {
		m := reBrackets.FindString(b)
		if m == "" {
			break
		}
		b = b[len(m):]
	}
	if i := strings.Index(b, " - "); i > 0 {
		// "Artist - Album" folders
		b = b[i+3:]
	}
	return strings.TrimSpace(b)
}

// Info returns the opened torrent's playable tracks, waiting briefly for
// metadata.
func (t *Torrents) Info(ctx context.Context, st *Store, hash string, wait time.Duration) (*TorrentInfo, error) {
	if !validHash(hash) {
		return nil, errTorrNotFound
	}
	row, err := st.Torrent(ctx, hash)
	if err != nil {
		return nil, errTorrNotFound
	}
	var tt *tsTorrent
	deadline := time.Now().Add(wait)
	for {
		tt, err = t.ensure(ctx, row)
		if err != nil {
			return nil, err
		}
		if len(tt.FileStats) > 0 || time.Now().After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(1500 * time.Millisecond):
		}
	}
	info := &TorrentInfo{Hash: hash, Title: row.Title, Peers: tt.ActivePeers, Seeders: tt.ConnectedSeeders, Speed: tt.DownloadSpeed, Tracks: []TorrentTrack{}}
	if len(tt.FileStats) == 0 {
		return info, nil
	}
	info.Ready = true
	// Cached CUE parsing (files column) saves re-reading cue sheets.
	var cues map[string][]cueTrack
	if row.Files != "" {
		_ = json.Unmarshal([]byte(row.Files), &cues)
	}
	if cues == nil {
		var complete bool
		cues, complete = t.readCues(ctx, hash, tt.FileStats)
		if b, err := json.Marshal(cues); err == nil && complete {
			_ = st.SetTorrentFiles(ctx, hash, string(b))
		}
	}
	artist, album := releaseArtistAlbum(row.Title)
	files := append([]tsFile(nil), tt.FileStats...)
	sort.SliceStable(files, func(i, j int) bool { return naturalLess(files[i].Path, files[j].Path) })
	for _, f := range files {
		ext := extOf(f.Path)
		if !audioExts[ext] {
			continue
		}
		dir := path.Dir(f.Path)
		alb := firstNonEmpty(dirAlbum(dir), album)
		if ct, ok := cues[strconv.Itoa(f.ID)]; ok && len(ct) > 0 {
			for i, c := range ct {
				tr := TorrentTrack{Dir: dir, Number: i + 1, Size: f.Length, Native: false}
				tr.Track = Track{ID: fmt.Sprintf("t:%s:%d:%d", hash, f.ID, c.Start), Title: c.Title, Artist: firstNonEmpty(c.Performer, artist),
					Album: alb, Position: i + 1,
					Src: &TorrentSrc{Hash: hash, File: f.ID, Start: c.Start, End: c.End, Ext: ext, Lossless: losslessExts[ext]}}
				if c.End > 0 {
					tr.Duration = int((c.End - c.Start) / 1000)
				}
				info.Tracks = append(info.Tracks, tr)
			}
			continue
		}
		num, title := parseFileTitle(path.Base(f.Path), artist)
		tr := TorrentTrack{Dir: dir, Number: num, Size: f.Length, Native: nativeExts[ext]}
		tr.Track = Track{ID: fmt.Sprintf("t:%s:%d", hash, f.ID), Title: title, Artist: artist, Album: alb, Position: num,
			Src: &TorrentSrc{Hash: hash, File: f.ID, Ext: ext, Lossless: losslessExts[ext]}}
		info.Tracks = append(info.Tracks, tr)
	}
	return info, nil
}

// naturalLess sorts "2 - x" before "10 - x".
func naturalLess(a, b string) bool {
	for a != "" && b != "" {
		ca, cb := a[0], b[0]
		if isDigit(ca) && isDigit(cb) {
			i, j := 0, 0
			for i < len(a) && isDigit(a[i]) {
				i++
			}
			for j < len(b) && isDigit(b[j]) {
				j++
			}
			na, _ := strconv.Atoi(a[:i])
			nb, _ := strconv.Atoi(b[:j])
			if na != nb {
				return na < nb
			}
			a, b = a[i:], b[j:]
			continue
		}
		la, lb := strings.ToLower(a[:1]), strings.ToLower(b[:1])
		if la != lb {
			return la < lb
		}
		a, b = a[1:], b[1:]
	}
	return len(a) < len(b)
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// MatchAlbum aligns an album's catalog tracks with the torrent's files.
func MatchAlbum(album *Album, tracks []TorrentTrack) []*Track {
	out := make([]*Track, len(album.Tracks))
	if len(tracks) == 0 {
		return out
	}
	nAlbum := normalize(album.Title)
	// Prefer files in a folder named after the album (discographies).
	var pool []TorrentTrack
	for _, tr := range tracks {
		if nAlbum != "" && (strings.Contains(normalize(tr.Dir), nAlbum) || strings.Contains(normalize(tr.Album), nAlbum)) {
			pool = append(pool, tr)
		}
	}
	if len(pool) == 0 {
		dirs := map[string]bool{}
		for _, tr := range tracks {
			dirs[tr.Dir] = true
		}
		if len(dirs) > 1 && len(tracks) > len(album.Tracks)+4 {
			return out // a discography without this album's folder
		}
		pool = tracks
	}
	used := make([]bool, len(pool))
	// 1) title match
	for i, at := range album.Tracks {
		nt := normalize(at.Title)
		best, bestScore := -1, 0
		for j, tr := range pool {
			if used[j] {
				continue
			}
			nf := normalize(tr.Title)
			score := 0
			switch {
			case nf == nt:
				score = 100
			case nt != "" && strings.Contains(nf, nt):
				score = 70
			case nf != "" && strings.Contains(nt, nf) && len(nf) > 3:
				score = 50
			}
			if score > 0 && tr.Number == at.Position {
				score += 10
			}
			if score > bestScore {
				best, bestScore = j, score
			}
		}
		if best >= 0 {
			used[best] = true
			out[i] = mergeTrack(at, pool[best])
		}
	}
	// 2) same count: by order for the rest
	if len(pool) == len(album.Tracks) {
		for i := range out {
			if out[i] == nil && !used[i] {
				used[i] = true
				out[i] = mergeTrack(album.Tracks[i], pool[i])
			}
		}
	}
	// 3) by track number
	for i, at := range album.Tracks {
		if out[i] != nil {
			continue
		}
		for j, tr := range pool {
			if !used[j] && tr.Number == at.Position && at.Position > 0 {
				used[j] = true
				out[i] = mergeTrack(at, tr)
				break
			}
		}
	}
	return out
}

func mergeTrack(cat Track, tr TorrentTrack) *Track {
	m := cat
	m.ID = tr.ID
	m.Src = tr.Src
	return &m
}

// ---- CUE sheets ----

type cueTrack struct {
	Title     string `json:"t"`
	Performer string `json:"p,omitempty"`
	Start     int64  `json:"s"` // ms
	End       int64  `json:"e,omitempty"`
}

// readCues parses the .cue sheets of single-file album images and maps
// the image's file id to its tracks.
func (t *Torrents) readCues(ctx context.Context, hash string, files []tsFile) (map[string][]cueTrack, bool) {
	out := map[string][]cueTrack{}
	complete := true
	byDir := map[string][]tsFile{}
	for _, f := range files {
		byDir[path.Dir(f.Path)] = append(byDir[path.Dir(f.Path)], f)
	}
	for _, f := range files {
		if extOf(f.Path) != "cue" || f.Length > 512<<10 {
			continue
		}
		dir := path.Dir(f.Path)
		var audio []tsFile
		for _, g := range byDir[dir] {
			if audioExts[extOf(g.Path)] {
				audio = append(audio, g)
			}
		}
		if len(audio) == 0 || len(audio) > 3 {
			continue // per-track files: the cue is not needed
		}
		raw, err := t.readSmall(ctx, hash, f.ID, f.Length)
		if err != nil {
			complete = false // no peers yet: try again next time
			continue
		}
		fileName, tracks := parseCue(raw)
		if len(tracks) < 2 {
			continue
		}
		target := matchCueFile(fileName, audio)
		if target == nil {
			continue
		}
		if _, dup := out[strconv.Itoa(target.ID)]; dup {
			continue
		}
		out[strconv.Itoa(target.ID)] = tracks
	}
	return out, complete
}

func matchCueFile(name string, audio []tsFile) *tsFile {
	want := normalize(strings.TrimSuffix(path.Base(strings.ReplaceAll(name, "\\", "/")), path.Ext(name)))
	for i := range audio {
		if normalize(strings.TrimSuffix(path.Base(audio[i].Path), path.Ext(audio[i].Path))) == want {
			return &audio[i]
		}
	}
	if len(audio) == 1 {
		return &audio[0]
	}
	return nil
}

func (t *Torrents) readSmall(ctx context.Context, hash string, id int, size int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	resp, err := t.openStream(ctx, hash, id, "")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(io.LimitReader(resp.Body, size+1))
}

var (
	reCueFile  = regexp.MustCompile(`(?i)^FILE\s+"?(.*?)"?\s+(WAVE|MP3|AIFF|BINARY|FLAC)?\s*$`)
	reCueTrack = regexp.MustCompile(`(?i)^TRACK\s+(\d+)\s+AUDIO`)
	reCueTitle = regexp.MustCompile(`(?i)^TITLE\s+"?(.*?)"?\s*$`)
	reCuePerf  = regexp.MustCompile(`(?i)^PERFORMER\s+"?(.*?)"?\s*$`)
	reCueIndex = regexp.MustCompile(`(?i)^INDEX\s+01\s+(\d+):(\d{1,2}):(\d{1,2})`)
)

// parseCue reads a cue sheet (UTF-8 or Windows-1251) with a single FILE.
func parseCue(raw []byte) (string, []cueTrack) {
	raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
	if !utf8.Valid(raw) {
		if dec, err := charmap.Windows1251.NewDecoder().Bytes(raw); err == nil {
			raw = dec
		}
	}
	var file string
	files := 0
	var tracks []cueTrack
	cur := -1
	for _, line := range strings.Split(strings.ReplaceAll(string(raw), "\r", ""), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case reCueFile.MatchString(line):
			files++
			file = reCueFile.FindStringSubmatch(line)[1]
		case reCueTrack.MatchString(line):
			tracks = append(tracks, cueTrack{Start: -1})
			cur = len(tracks) - 1
		case cur >= 0 && reCueTitle.MatchString(line):
			tracks[cur].Title = reCueTitle.FindStringSubmatch(line)[1]
		case cur >= 0 && reCuePerf.MatchString(line):
			tracks[cur].Performer = reCuePerf.FindStringSubmatch(line)[1]
		case cur >= 0 && reCueIndex.MatchString(line):
			m := reCueIndex.FindStringSubmatch(line)
			mm, _ := strconv.Atoi(m[1])
			ss, _ := strconv.Atoi(m[2])
			ff, _ := strconv.Atoi(m[3])
			tracks[cur].Start = int64(mm)*60000 + int64(ss)*1000 + int64(ff)*1000/75
		}
	}
	if files != 1 {
		return "", nil
	}
	out := tracks[:0]
	for _, tr := range tracks {
		if tr.Start >= 0 {
			out = append(out, tr)
		}
	}
	for i := range out {
		if i+1 < len(out) {
			out[i].End = out[i+1].Start
		}
		if out[i].Title == "" {
			out[i].Title = fmt.Sprintf("Track %02d", i+1)
		}
	}
	return file, out
}

// ---- streaming ----

func (t *Torrents) streamURL(hash string, id int) string {
	q := url.Values{}
	q.Set("link", hash)
	q.Set("index", strconv.Itoa(id))
	q.Set("play", "")
	return t.torr + "/stream?" + q.Encode()
}

func (t *Torrents) openStream(ctx context.Context, hash string, id int, rng string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.streamURL(hash, id), nil)
	if err != nil {
		return nil, err
	}
	if t.torrAuth != "" {
		req.Header.Set("Authorization", t.torrAuth)
	}
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	resp, err := t.stream.Do(req)
	if err != nil {
		return nil, fmt.Errorf("torrserver: %w", shortErr(err))
	}
	switch resp.StatusCode {
	case http.StatusOK, http.StatusPartialContent, http.StatusRequestedRangeNotSatisfiable:
		return resp, nil
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, errTorrNotFound
	}
	return nil, fmt.Errorf("torrserver stream: HTTP %d", resp.StatusCode)
}

var mimeByExt = map[string]string{"flac": "audio/flac", "mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac",
	"ogg": "audio/ogg", "opus": "audio/ogg", "wav": "audio/wav"}
