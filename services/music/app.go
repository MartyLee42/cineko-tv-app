package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type App struct {
	cfg      config
	st       *Store
	log      *slog.Logger
	dz       *Deezer
	yt       *YouTube
	tor      *Torrents
	ai       *AI
	zv       *Zaycev
	zvStream *http.Client
	cache    *AudioCache  // nil when MUSIC_CACHE_GB=0
	ext      *http.Client // Deezer, LRCLIB, images (optionally through MUSIC_PROXY_URL)
	auth     *http.Client
	tcSem    chan struct{}

	sessMu   sync.Mutex
	sessions map[string]cachedSession

	resolveMu sync.Mutex
	resolving map[string]*resolveCall

	lyrics *ttlCache
}

type cachedSession struct {
	user *User
	exp  time.Time
}

type resolveCall struct {
	done    chan struct{}
	videoID string
	err     error
}

// User is the Cineko account behind the session cookie.
type User struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
	CSRF        string `json:"csrfToken,omitempty"`
}

func newApp(cfg config, st *Store, log *slog.Logger) *App {
	tr := &http.Transport{MaxIdleConnsPerHost: 16, IdleConnTimeout: 90 * time.Second, ResponseHeaderTimeout: 20 * time.Second}
	if cfg.ProxyURL != "" {
		if pu, err := url.Parse(cfg.ProxyURL); err == nil {
			tr.Proxy = http.ProxyURL(pu)
		}
	}
	ext := &http.Client{Transport: tr, Timeout: 25 * time.Second}
	a := &App{
		cfg: cfg, st: st, log: log,
		dz:        newDeezer(cfg.DeezerURL, ext),
		yt:        newYouTube(cfg.InvidiousURL, cfg.Region),
		tor:       newTorrents(cfg),
		ai:        newAI(cfg.AIKey, cfg.AIBase, cfg.AIModel, cfg.AIPerDay, cfg.AIDayTokens),
		zv:        newZaycev(),
		zvStream:  &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 20 * time.Second, MaxIdleConnsPerHost: 8}},
		ext:       ext,
		auth:      &http.Client{Timeout: 8 * time.Second, Transport: &http.Transport{Proxy: nil}},
		tcSem:     make(chan struct{}, cfg.MaxTranscode),
		sessions:  map[string]cachedSession{},
		resolving: map[string]*resolveCall{},
		lyrics:    newTTLCache(2000),
	}
	if cfg.CacheBytes > 0 {
		a.cache = newAudioCache(filepath.Join(cfg.DataDir, "audio"), cfg.CacheBytes)
	}
	return a
}

// ---- helpers ----

type apiError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string { return e.Message }

func errStatus(status int, code, msg string) *apiError {
	return &apiError{Status: status, Code: code, Message: msg}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *App) fail(w http.ResponseWriter, r *http.Request, err error) {
	var ae *apiError
	switch {
	case errors.As(err, &ae):
	case errors.Is(err, errNotFound), errors.Is(err, errDeezerNotFound), errors.Is(err, errTorrNotFound):
		ae = errStatus(404, "not_found", "Не найдено")
	case errors.Is(err, errReleaseGone):
		ae = errStatus(410, "release_gone", "Результаты поиска устарели — повторите поиск")
	case errors.Is(err, errTorrNotConfigured), errors.Is(err, errYTNotConfigured):
		ae = errStatus(503, "not_configured", "Источник не настроен на сервере")
	case errors.Is(err, errYTNoMatch):
		ae = errStatus(404, "no_match", "Не нашли этот трек на YouTube")
	case errors.Is(err, context.Canceled):
		return
	default:
		a.log.Warn("request failed", "path", r.URL.Path, "err", err.Error())
		ae = errStatus(502, "upstream", "Сервис временно недоступен")
	}
	writeJSON(w, ae.Status, ae)
}

func readJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		return errStatus(400, "bad_request", "Некорректный запрос")
	}
	return nil
}

func pathInt(r *http.Request, name string) (int64, error) {
	n, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil || n < 0 {
		return 0, errStatus(400, "bad_request", "Некорректный id")
	}
	return n, nil
}

// ---- auth ----

const sessionCookie = "mt_session"

func (a *App) currentUser(r *http.Request) (*User, error) {
	if a.cfg.DevUser != "" {
		return &User{ID: "dev-" + a.cfg.DevUser, Username: a.cfg.DevUser, DisplayName: a.cfg.DevUser, Role: "admin"}, nil
	}
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return nil, nil
	}
	sum := sha256.Sum256([]byte(c.Value))
	key := hex.EncodeToString(sum[:])
	a.sessMu.Lock()
	if s, ok := a.sessions[key]; ok && time.Now().Before(s.exp) {
		a.sessMu.Unlock()
		return s.user, nil
	}
	a.sessMu.Unlock()

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, a.cfg.APIURL+"/api/v1/auth/session", nil)
	if err != nil {
		return nil, err
	}
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: c.Value})
	if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
		req.Header.Set("X-Forwarded-For", ip)
	}
	resp, err := a.auth.Do(req)
	if err != nil {
		return nil, errStatus(503, "auth_unavailable", "Cineko недоступен")
	}
	defer resp.Body.Close()
	var u *User
	switch resp.StatusCode {
	case http.StatusOK:
		var body struct {
			Kind string `json:"kind"`
			User struct {
				ID          string `json:"id"`
				Username    string `json:"username"`
				DisplayName string `json:"display_name"`
				Role        string `json:"role"`
			} `json:"user"`
			CSRF string `json:"csrf_token"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&body); err != nil || body.User.ID == "" {
			return nil, errStatus(503, "auth_unavailable", "Cineko недоступен")
		}
		u = &User{ID: body.User.ID, Username: body.User.Username, DisplayName: firstNonEmpty(body.User.DisplayName, body.User.Username),
			Role: body.User.Role, CSRF: body.CSRF}
	case http.StatusUnauthorized, http.StatusForbidden:
		u = nil
	default:
		return nil, errStatus(503, "auth_unavailable", "Cineko недоступен")
	}
	a.sessMu.Lock()
	if len(a.sessions) > 2000 {
		a.sessions = map[string]cachedSession{}
	}
	ttl := 60 * time.Second
	if u == nil {
		ttl = 5 * time.Second
	}
	a.sessions[key] = cachedSession{user: u, exp: time.Now().Add(ttl)}
	a.sessMu.Unlock()
	return u, nil
}

type handler func(w http.ResponseWriter, r *http.Request, u *User) error

// authed requires a Cineko session; state-changing requests must also be
// same-origin (custom header + Origin check).
func (a *App) authed(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, err := a.currentUser(r)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		if u == nil {
			writeJSON(w, 401, errStatus(401, "unauthorized", "Войдите в Cineko"))
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if r.Header.Get("X-Requested-With") != "marty-music" {
				writeJSON(w, 403, errStatus(403, "csrf", "Запрос отклонён"))
				return
			}
			if o := r.Header.Get("Origin"); o != "" {
				ou, err := url.Parse(o)
				if err != nil || !strings.EqualFold(ou.Host, r.Host) {
					writeJSON(w, 403, errStatus(403, "bad_origin", "Запрос отклонён"))
					return
				}
			}
		}
		if err := h(w, r, u); err != nil {
			a.fail(w, r, err)
		}
	}
}

// ---- routes ----

func (a *App) routes() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /music/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })

	api := func(pattern string, h handler) { m.HandleFunc(pattern, a.authed(h)) }
	api("GET /music/api/me", a.hMe)
	api("GET /music/api/home", a.hHome)
	api("GET /music/api/flow", a.hFlow)
	api("GET /music/api/genres", a.hGenres)
	api("GET /music/api/genre/{id}", a.hGenre)
	api("GET /music/api/search", a.hSearch)
	api("GET /music/api/artist/{id}", a.hArtist)
	api("GET /music/api/artist/{id}/radio", a.hArtistRadio)
	api("GET /music/api/album/{id}", a.hAlbum)
	api("GET /music/api/playlist/{id}", a.hDzPlaylist)
	api("GET /music/api/track/{id}/candidates", a.hCandidates)
	api("PUT /music/api/track/{id}/match", a.hSetMatch)
	api("DELETE /music/api/track/{id}/match", a.hForgetMatch)
	api("GET /music/api/resolve/{id}", a.hResolve)
	api("GET /music/api/play/{id}", a.hPlay)
	api("HEAD /music/api/play/{id}", a.hPlay)
	api("GET /music/api/yt/{vid}", a.hYT)
	api("HEAD /music/api/yt/{vid}", a.hYT)
	api("GET /music/api/ytfind", a.hYTFind)
	api("GET /music/api/ytq", a.hYTQuery)
	api("GET /music/api/ytsearch", a.hYTSearch)
	api("HEAD /music/api/ytq", a.hYTQuery)
	api("POST /music/api/import/match", a.hImportMatch)
	api("POST /music/api/ai/playlist", a.hAIPlaylist)
	api("GET /music/api/tabs/search", a.hTabsSearch)
	api("PUT /music/api/torrentchoice", a.hTorrentChoice)
	api("GET /music/api/zv/search", a.hZvSearch)
	api("GET /music/api/zv/{id}", a.hZvPlay)
	// No explicit HEAD here: GET serves HEAD too, and "HEAD /zv/{id}" would
	// conflict with "GET /zv/search" (the router panics at startup).
	api("DELETE /music/api/torrentchoice", a.hTorrentChoice)
	api("GET /music/api/tabs/sheet", a.hTabSheet)
	api("GET /music/api/lyrics", a.hLyrics)
	api("GET /music/api/img", a.hImage)

	api("GET /music/api/torrents/search", a.hTorrentSearch)
	api("POST /music/api/torrents/open", a.hTorrentOpen)
	api("GET /music/api/torrents/{hash}", a.hTorrentInfo)
	api("GET /music/api/stream/{hash}/{file}", a.hTorrentStream)
	api("HEAD /music/api/stream/{hash}/{file}", a.hTorrentStream)

	api("GET /music/api/library", a.hLibrary)
	api("GET /music/api/likes", a.hLikes)
	api("PUT /music/api/likes", a.hLike)
	api("DELETE /music/api/likes/{id}", a.hUnlike)
	api("PUT /music/api/saved/{kind}/{id}", a.hSave)
	api("DELETE /music/api/saved/{kind}/{id}", a.hUnsave)
	api("GET /music/api/playlists", a.hPlaylists)
	api("POST /music/api/playlists", a.hCreatePlaylist)
	api("GET /music/api/playlists/{id}", a.hPlaylist)
	api("PATCH /music/api/playlists/{id}", a.hUpdatePlaylist)
	api("DELETE /music/api/playlists/{id}", a.hDeletePlaylist)
	api("POST /music/api/playlists/{id}/tracks", a.hAddToPlaylist)
	api("DELETE /music/api/playlists/{id}/tracks/{entry}", a.hRemoveFromPlaylist)
	api("PUT /music/api/playlists/{id}/order", a.hReorderPlaylist)
	api("GET /music/api/history", a.hHistory)
	api("POST /music/api/history", a.hAddHistory)

	m.HandleFunc("/music/api/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 404, errStatus(404, "not_found", "Не найдено"))
	})
	m.HandleFunc("/music", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/music/", http.StatusMovedPermanently)
	})
	m.HandleFunc("/music/", a.static)
	return securityHeaders(m)
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.ServeHTTP(w, r)
	})
}

// static serves the web app (SPA: unknown paths get index.html).
func (a *App) static(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/music/")
	clean := filepath.Clean("/" + rel)
	full := filepath.Join(a.cfg.StaticDir, clean)
	if fi, err := os.Stat(full); err == nil && !fi.IsDir() {
		if strings.HasPrefix(clean, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		http.ServeFile(w, r, full)
		return
	}
	if strings.HasPrefix(clean, "/assets/") {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, filepath.Join(a.cfg.StaticDir, "index.html"))
}

// ---- catalog handlers ----

func (a *App) hMe(w http.ResponseWriter, r *http.Request, u *User) error {
	writeJSON(w, 200, map[string]any{
		"user": u,
		"features": map[string]bool{
			"youtube":  a.yt.Configured(),
			"torrents": a.tor.SearchConfigured(),
			"ai":       a.ai.Configured(),
		},
	})
	return nil
}

func (a *App) hGenres(w http.ResponseWriter, r *http.Request, u *User) error {
	g, err := a.dz.Genres(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, 200, g)
	return nil
}

func (a *App) hGenre(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	c, err := a.dz.Chart(r.Context(), id)
	if err != nil {
		return err
	}
	writeJSON(w, 200, c)
	return nil
}

func (a *App) hSearch(w http.ResponseWriter, r *http.Request, u *User) error {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, 200, SearchResult{Tracks: []Track{}, Albums: []Album{}, Artists: []Artist{}, Playlists: []DzPlaylist{}})
		return nil
	}
	if len(q) > 200 {
		q = q[:200]
	}
	res, err := a.dz.Search(r.Context(), q)
	if err != nil {
		return err
	}
	writeJSON(w, 200, res)
	return nil
}

func (a *App) hArtist(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	p, err := a.dz.Artist(r.Context(), id)
	if err != nil {
		return err
	}
	writeJSON(w, 200, p)
	return nil
}

func (a *App) hArtistRadio(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	ts, err := a.dz.ArtistRadio(r.Context(), id)
	if err != nil || len(ts) == 0 {
		// Some artists have no radio: their top tracks instead.
		ts, err = a.dz.ArtistTop(r.Context(), id, 50)
		if err != nil {
			return err
		}
	}
	writeJSON(w, 200, ts)
	return nil
}

func (a *App) hAlbum(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	al, err := a.dz.Album(r.Context(), id)
	if err != nil {
		return err
	}
	writeJSON(w, 200, al)
	return nil
}

func (a *App) hDzPlaylist(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	p, err := a.dz.Playlist(r.Context(), id)
	if err != nil {
		return err
	}
	writeJSON(w, 200, p)
	return nil
}

// ---- home / flow ----

// topArtists ranks the account's artists by recent plays (and likes).
func (a *App) topArtists(ctx context.Context, user string, n int) []ArtistRef {
	score := map[int64]float64{}
	names := map[int64]string{}
	hist, _ := a.st.HistoryRaw(ctx, user, 400)
	for i, raw := range hist {
		var t Track
		if json.Unmarshal(raw, &t) != nil || t.ArtistID == 0 {
			continue
		}
		score[t.ArtistID] += 1 + float64(len(hist)-i)/float64(len(hist)) // recent plays weigh more
		names[t.ArtistID] = t.Artist
	}
	likes, _ := a.st.Likes(ctx, user)
	for _, raw := range likes {
		var t Track
		if json.Unmarshal(raw, &t) != nil || t.ArtistID == 0 {
			continue
		}
		score[t.ArtistID] += 2
		names[t.ArtistID] = t.Artist
	}
	saved, _ := a.st.Saved(ctx, user)
	for _, s := range saved {
		if s.Kind == "artist" {
			if id, err := strconv.ParseInt(s.ID, 10, 64); err == nil {
				var ar Artist
				_ = json.Unmarshal(s.Data, &ar)
				score[id] += 5
				names[id] = ar.Name
			}
		}
	}
	ids := make([]int64, 0, len(score))
	for id := range score {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return score[ids[i]] > score[ids[j]] })
	if len(ids) > n {
		ids = ids[:n]
	}
	out := make([]ArtistRef, 0, len(ids))
	for _, id := range ids {
		out = append(out, ArtistRef{ID: id, Name: names[id]})
	}
	return out
}

func (a *App) hHome(w http.ResponseWriter, r *http.Request, u *User) error {
	ctx := r.Context()
	type home struct {
		Recent       []json.RawMessage `json:"recent"`
		Chart        *Chart            `json:"chart"`
		Mixes        []Artist          `json:"mixes"`
		RecentAlbums []Album           `json:"recentAlbums"`
	}
	out := home{Recent: []json.RawMessage{}, Mixes: []Artist{}, RecentAlbums: []Album{}}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		c, err := a.dz.Chart(ctx, 0)
		if err != nil {
			a.log.Warn("chart", "err", err.Error())
			c = &Chart{Tracks: []Track{}, Albums: []Album{}, Artists: []Artist{}, Playlists: []DzPlaylist{}}
		}
		out.Chart = c
	}()
	go func() {
		defer wg.Done()
		top := a.topArtists(ctx, u.ID, 8)
		mixes := make([]Artist, len(top))
		var mwg sync.WaitGroup
		for i, ar := range top {
			mwg.Add(1)
			go func(i int, ar ArtistRef) {
				defer mwg.Done()
				p, err := a.dz.Artist(ctx, ar.ID)
				if err == nil {
					mixes[i] = p.Artist
				} else {
					mixes[i] = Artist{ID: ar.ID, Name: ar.Name}
				}
			}(i, ar)
		}
		mwg.Wait()
		out.Mixes = mixes
	}()
	hist, _ := a.st.History(ctx, u.ID, 30)
	out.Recent = hist
	// Recently played albums (distinct, from history).
	seen := map[int64]bool{}
	for _, raw := range hist {
		var t Track
		if json.Unmarshal(raw, &t) != nil || t.AlbumID == 0 || seen[t.AlbumID] {
			continue
		}
		seen[t.AlbumID] = true
		out.RecentAlbums = append(out.RecentAlbums, Album{ID: t.AlbumID, Title: t.Album, Artist: t.Artist, ArtistID: t.ArtistID, Cover: t.Cover, CoverBig: t.CoverBig})
		if len(out.RecentAlbums) >= 12 {
			break
		}
	}
	wg.Wait()
	writeJSON(w, 200, out)
	return nil
}

// hFlow: "Моя волна" — an endless personal mix from the radios of the
// account's top artists (or of one artist / the charts).
func (a *App) hFlow(w http.ResponseWriter, r *http.Request, u *User) error {
	if waveParams(r.URL.Query()) {
		return a.hWave(w, r, u)
	}
	ctx := r.Context()
	var seeds []ArtistRef
	if s := r.URL.Query().Get("artist"); s != "" {
		if id, err := strconv.ParseInt(s, 10, 64); err == nil {
			seeds = []ArtistRef{{ID: id}}
		}
	} else {
		top := a.topArtists(ctx, u.ID, 12)
		rand.Shuffle(len(top), func(i, j int) { top[i], top[j] = top[j], top[i] })
		if len(top) > 5 {
			top = top[:5]
		}
		seeds = top
	}
	recent := map[string]bool{}
	if hist, err := a.st.HistoryRaw(ctx, u.ID, 60); err == nil {
		for _, raw := range hist {
			var t Track
			if json.Unmarshal(raw, &t) == nil {
				recent[t.ID] = true
			}
		}
	}
	for _, x := range strings.Split(r.URL.Query().Get("exclude"), ",") {
		if x != "" {
			recent[x] = true
		}
	}
	lists := make([][]Track, len(seeds))
	var wg sync.WaitGroup
	for i, s := range seeds {
		wg.Add(1)
		go func(i int, id int64) {
			defer wg.Done()
			ts, err := a.dz.ArtistRadio(ctx, id)
			if err != nil || len(ts) == 0 {
				ts, _ = a.dz.ArtistTop(ctx, id, 30)
			}
			rand.Shuffle(len(ts), func(a, b int) { ts[a], ts[b] = ts[b], ts[a] })
			lists[i] = ts
		}(i, s.ID)
	}
	wg.Wait()
	if len(seeds) == 0 {
		c, err := a.dz.Chart(ctx, 0)
		if err != nil {
			return err
		}
		ts := append([]Track(nil), c.Tracks...)
		rand.Shuffle(len(ts), func(a, b int) { ts[a], ts[b] = ts[b], ts[a] })
		lists = [][]Track{ts}
	}
	out := []Track{}
	seen := map[string]bool{}
	lastArtist := int64(-1)
	for round := 0; len(out) < 40 && round < 60; round++ {
		added := false
		for _, l := range lists {
			for k, t := range l {
				if seen[t.ID] || recent[t.ID] {
					continue
				}
				if t.ArtistID == lastArtist && len(lists) > 1 {
					continue
				}
				seen[t.ID] = true
				out = append(out, t)
				lastArtist = t.ArtistID
				l[k] = Track{ID: t.ID}
				added = true
				break
			}
		}
		if !added {
			break
		}
	}
	writeJSON(w, 200, out)
	return nil
}

// ---- library handlers ----

// cleanTrack validates a client-sent track snapshot.
func cleanTrack(r *http.Request) (*Track, []byte, error) {
	var t Track
	if err := readJSON(r, &t); err != nil {
		return nil, nil, err
	}
	if !validTrackID(t.ID) || strings.TrimSpace(t.Title) == "" {
		return nil, nil, errStatus(400, "bad_track", "Некорректный трек")
	}
	b, _ := json.Marshal(t)
	return &t, b, nil
}

func validTrackID(id string) bool {
	if len(id) > 120 {
		return false
	}
	if rest, ok := strings.CutPrefix(id, "dz:"); ok {
		_, err := strconv.ParseInt(rest, 10, 64)
		return err == nil
	}
	if rest, ok := strings.CutPrefix(id, "yt:"); ok {
		return validVideoID(rest)
	}
	if yqRe.MatchString(id) {
		return true
	}
	if rest, ok := strings.CutPrefix(id, "zv:"); ok {
		return zvIDRe.MatchString(rest)
	}
	if rest, ok := strings.CutPrefix(id, "t:"); ok {
		parts := strings.Split(rest, ":")
		return len(parts) >= 2 && validHash(parts[0])
	}
	return false
}

func (a *App) hLibrary(w http.ResponseWriter, r *http.Request, u *User) error {
	ids, err := a.st.LikedIDs(r.Context(), u.ID)
	if err != nil {
		return err
	}
	saved, err := a.st.Saved(r.Context(), u.ID)
	if err != nil {
		return err
	}
	pls, err := a.st.Playlists(r.Context(), u.ID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"likes": ids, "saved": saved, "playlists": pls})
	return nil
}

func (a *App) hLikes(w http.ResponseWriter, r *http.Request, u *User) error {
	l, err := a.st.Likes(r.Context(), u.ID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, l)
	return nil
}

func (a *App) hLike(w http.ResponseWriter, r *http.Request, u *User) error {
	t, b, err := cleanTrack(r)
	if err != nil {
		return err
	}
	if err := a.st.Like(r.Context(), u.ID, t.ID, b); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func (a *App) hUnlike(w http.ResponseWriter, r *http.Request, u *User) error {
	if err := a.st.Unlike(r.Context(), u.ID, r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func savedKind(k string) bool { return k == "album" || k == "artist" || k == "playlist" }

func (a *App) hSave(w http.ResponseWriter, r *http.Request, u *User) error {
	kind, id := r.PathValue("kind"), r.PathValue("id")
	if !savedKind(kind) || id == "" || len(id) > 40 {
		return errStatus(400, "bad_request", "Некорректный запрос")
	}
	var data json.RawMessage
	if err := readJSON(r, &data); err != nil {
		return err
	}
	if err := a.st.Save(r.Context(), u.ID, kind, id, data); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func (a *App) hUnsave(w http.ResponseWriter, r *http.Request, u *User) error {
	if err := a.st.Unsave(r.Context(), u.ID, r.PathValue("kind"), r.PathValue("id")); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func (a *App) hPlaylists(w http.ResponseWriter, r *http.Request, u *User) error {
	p, err := a.st.Playlists(r.Context(), u.ID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, p)
	return nil
}

type playlistBody struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Tracks      []Track `json:"tracks"`
}

func (a *App) hCreatePlaylist(w http.ResponseWriter, r *http.Request, u *User) error {
	var b playlistBody
	if err := readJSON(r, &b); err != nil {
		return err
	}
	name := strings.TrimSpace(b.Name)
	if name == "" || len([]rune(name)) > 100 {
		return errStatus(400, "bad_name", "Укажите название")
	}
	id, err := a.st.CreatePlaylist(r.Context(), u.ID, name, clip(b.Description, 500))
	if err != nil {
		return err
	}
	if rows := trackRows(b.Tracks); len(rows) > 0 {
		if err := a.st.AddToPlaylist(r.Context(), u.ID, id, rows); err != nil {
			return err
		}
	}
	writeJSON(w, 201, map[string]int64{"id": id})
	return nil
}

func trackRows(ts []Track) []trackRow {
	out := []trackRow{}
	for _, t := range ts {
		if !validTrackID(t.ID) || t.Title == "" {
			continue
		}
		b, _ := json.Marshal(t)
		out = append(out, trackRow{ID: t.ID, Data: b})
		if len(out) >= 1000 {
			break
		}
	}
	return out
}

func (a *App) hPlaylist(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	p, entries, err := a.st.Playlist(r.Context(), u.ID, id)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"playlist": p, "entries": entries})
	return nil
}

func (a *App) hUpdatePlaylist(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	var b playlistBody
	if err := readJSON(r, &b); err != nil {
		return err
	}
	name := strings.TrimSpace(b.Name)
	if name == "" || len([]rune(name)) > 100 {
		return errStatus(400, "bad_name", "Укажите название")
	}
	if err := a.st.UpdatePlaylist(r.Context(), u.ID, id, name, clip(b.Description, 500)); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func (a *App) hDeletePlaylist(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	if err := a.st.DeletePlaylist(r.Context(), u.ID, id); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func (a *App) hAddToPlaylist(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	var b playlistBody
	if err := readJSON(r, &b); err != nil {
		return err
	}
	rows := trackRows(b.Tracks)
	if len(rows) == 0 {
		return errStatus(400, "bad_track", "Нет треков")
	}
	if err := a.st.AddToPlaylist(r.Context(), u.ID, id, rows); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func (a *App) hRemoveFromPlaylist(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	entry, err := pathInt(r, "entry")
	if err != nil {
		return err
	}
	if err := a.st.RemoveFromPlaylist(r.Context(), u.ID, id, entry); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func (a *App) hReorderPlaylist(w http.ResponseWriter, r *http.Request, u *User) error {
	id, err := pathInt(r, "id")
	if err != nil {
		return err
	}
	var b struct {
		Entries []int64 `json:"entries"`
	}
	if err := readJSON(r, &b); err != nil {
		return err
	}
	if err := a.st.ReorderPlaylist(r.Context(), u.ID, id, b.Entries); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func (a *App) hHistory(w http.ResponseWriter, r *http.Request, u *User) error {
	h, err := a.st.History(r.Context(), u.ID, 100)
	if err != nil {
		return err
	}
	writeJSON(w, 200, h)
	return nil
}

func (a *App) hAddHistory(w http.ResponseWriter, r *http.Request, u *User) error {
	t, b, err := cleanTrack(r)
	if err != nil {
		return err
	}
	if err := a.st.AddHistory(r.Context(), u.ID, t.ID, b); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}
