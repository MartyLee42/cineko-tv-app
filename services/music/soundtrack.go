package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Soundtracks: «Послушать саундтрек» on a Cineko title. The title (name,
// original name, year, composer) comes from Cineko's API with the
// listener's session, so the client only sends the title's id. Tracks come
// from the official soundtrack / score albums on Deezer; when none is found,
// from the AI (the film travels as data inside the usual "request" field,
// with the same injection guard and limits). One playlist per account and
// title: pressing again opens the same playlist.

// stFilm is what the album search and the AI prompt need.
type stFilm struct {
	Title     string   // localised
	Original  string   // original title
	Year      int      // 0 = unknown
	Series    bool     // series: any season's album fits
	Composers []string // TMDB crew "Original Music Composer"
}

// titles: the original title first (soundtrack albums use it), then the
// localised one when it differs.
func (f stFilm) titles() []string {
	out := []string{}
	for _, t := range []string{f.Original, f.Title} {
		if normalize(t) != "" && (len(out) == 0 || normalize(out[0]) != normalize(t)) {
			out = append(out, t)
		}
	}
	return out
}

// stMedia mirrors the fields of the API's MediaDetail used here.
type stMedia struct {
	Kind          string `json:"kind"`
	Title         string `json:"title"`
	OriginalTitle string `json:"original_title"`
	Year          *int   `json:"year"`
	Crew          []struct {
		Name string `json:"name"`
		Job  string `json:"job"`
	} `json:"crew"`
}

func filmFromMedia(m stMedia) stFilm {
	f := stFilm{Title: plain(m.Title, 120), Original: plain(m.OriginalTitle, 120), Series: m.Kind == "series"}
	if f.Title == "" {
		f.Title = f.Original
	}
	if m.Year != nil {
		f.Year = *m.Year
	}
	seen := map[string]bool{}
	for _, c := range m.Crew {
		n := plain(c.Name, 80)
		if (c.Job == "Original Music Composer" || c.Job == "Music") && n != "" && !seen[normalize(n)] && len(f.Composers) < 2 {
			seen[normalize(n)] = true
			f.Composers = append(f.Composers, n)
		}
	}
	return f
}

func wordSet(ws ...string) map[string]bool {
	m := map[string]bool{}
	for _, w := range ws {
		for _, x := range strings.Fields(w) {
			m[x] = true
		}
	}
	return m
}

// stMarker: words that say an album is a film's music.
var stMarker = wordSet("soundtrack soundtracks ost score motion picture music from film movie series television",
	"саундтрек саундтрэк музыка из фильма фильму кинофильма кинофильму сериала сериалу")

// stFiller: words that may surround the title besides the markers
// ("Music from the Motion Picture Pulp Fiction", "… [Expanded Edition]").
var stFiller = wordSet("the original official songs and of to inspired by complete expanded deluxe edition version remastered",
	"anniversary special collector s collectors vol volume part season netflix hbo amazon apple disney tv",
	"k к и оригинальный официальный песни сезон версия издание", "1 2 3 4 5 6 7 8 9 10")

// stBad: cover versions, karaoke and the like.
var stBad = wordSet("karaoke tribute lullaby lullabies lullabye cover covers chiptune 8bit piano renditions musicbox kids famous",
	"караоке колыбельные кавер каверы")

var stCoverArtist = regexp.MustCompile(`(?i)karaoke|tribute|lullab|music works|movie sounds|tv themes|soundtrack wonder|studio orchestra|piano|orchestra|philharmonic|starlite|sound alike`)

var stRoman = wordSet("ii iii iv v vi vii viii ix x")

// stFindTitle returns the word index of title inside album (both
// normalized word lists), or -1.
func stFindTitle(album, title []string) int {
	if len(title) == 0 {
		return -1
	}
	for i := 0; i+len(title) <= len(album); i++ {
		ok := true
		for j := range title {
			if album[i+j] != title[j] {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}

// stMin: an album needs this score to be used.
const stMin = 60

// scoreSoundtrackAlbum rates how surely al is f's soundtrack (≥ stMin:
// use it) and whether it is the score (composer's music) rather than the
// songs. Year counts only when the album has a release date (search
// results don't; album pages do).
func scoreSoundtrackAlbum(al Album, f stFilm) (score int, isScore bool) {
	aw := strings.Fields(normalize(al.Title))
	best := -1
	var rest []string
	for _, t := range f.titles() {
		tw := strings.Fields(normalize(t))
		i := stFindTitle(aw, tw)
		if i < 0 {
			continue
		}
		lead := aw[:i]
		okLead := true
		for _, w := range lead {
			if !stMarker[w] && !stFiller[w] {
				okLead = false
			}
		}
		if !okLead {
			continue
		}
		after := aw[i+len(tw):]
		r := append(append([]string{}, lead...), after...)
		if best < 0 || len(r) < len(rest) {
			best, rest = 40, r
			if !f.Series && len(after) > 0 && (isDigits(after[0]) || stRoman[after[0]]) {
				best = 0 // "Alien 3" for "Alien": a sequel (for series: a season)
			}
		}
	}
	if best < 0 {
		return -1, false
	}
	score = best
	marker, unknown := false, 0
	for _, w := range rest {
		switch {
		case stBad[w]:
			return -1, false
		case w == "score":
			isScore, marker = true, true
		case stMarker[w]:
			marker = true
		case !stFiller[w]:
			unknown++
		}
	}
	score -= 10 * min(unknown, 3)
	artist := normalize(al.Artist)
	composer := false
	for _, c := range f.Composers {
		nc := normalize(c)
		if nc == "" {
			continue
		}
		if artist == nc || (len(artist) >= 4 && (strings.Contains(artist, nc) || strings.Contains(nc, artist))) {
			composer = true
		}
		for _, x := range al.Artists {
			if normalize(x.Name) == nc {
				composer = true
			}
		}
	}
	switch {
	case composer:
		score += 30
		isScore = true
		if marker {
			score += 5
		}
	case marker:
		score += 30
		if stCoverArtist.MatchString(al.Artist) {
			score -= 40
		}
	default:
		return -1, false // just an album named like the film
	}
	if artist == "various artists" || artist == "разные исполнители" {
		score += 5
	}
	if al.Type == "single" {
		score -= 15
	}
	if y, err := strconv.Atoi(al.Year); err == nil && y > 0 && f.Year > 0 {
		switch d := y - f.Year; {
		case d < -1:
			score -= 40 // an older film of the same name
		case f.Series:
			score += 5
		case d <= 2:
			score += 15
		default:
			score -= 10 // a later re-release or a remake
		}
	}
	return score, isScore
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// soundtrackQueries are the album searches to run, most specific first.
func soundtrackQueries(f stFilm) []string {
	out := []string{}
	seen := map[string]bool{}
	add := func(q string) {
		if k := normalize(q); k != "" && !seen[k] {
			seen[k] = true
			out = append(out, q)
		}
	}
	ts := f.titles()
	if len(ts) == 0 {
		return out
	}
	add(ts[0] + " soundtrack")
	for _, c := range f.Composers {
		add(c + " " + ts[0])
	}
	add(ts[0])
	if len(ts) > 1 {
		add(ts[1] + " саундтрек")
		add(ts[1])
	}
	if len(out) > 5 {
		out = out[:5]
	}
	return out
}

type stScored struct {
	al      Album
	score   int
	isScore bool
}

// rankSoundtrackAlbums: albums scoring at least min, best first (fans break
// ties), duplicates dropped.
func rankSoundtrackAlbums(as []Album, f stFilm, min int) []stScored {
	seen := map[int64]bool{}
	out := []stScored{}
	for _, al := range as {
		if seen[al.ID] {
			continue
		}
		seen[al.ID] = true
		if s, sc := scoreSoundtrackAlbum(al, f); s >= min {
			out = append(out, stScored{al, s, sc})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].score != out[j].score {
			return out[i].score > out[j].score
		}
		return out[i].al.Fans > out[j].al.Fans
	})
	return out
}

// pickSoundtrackAlbums: the best songs album, then the best score album
// (either may be missing).
func pickSoundtrackAlbums(ranked []stScored) []Album {
	var songs, score *Album
	for i := range ranked {
		r := &ranked[i]
		if r.isScore && score == nil {
			score = &r.al
		} else if !r.isScore && songs == nil {
			songs = &r.al
		}
	}
	out := []Album{}
	for _, a := range []*Album{songs, score} {
		if a != nil {
			out = append(out, *a)
		}
	}
	return out
}

// stMaxTracks caps a soundtrack playlist.
const stMaxTracks = 100

// mergeAlbumTracks joins the albums' tracks: no duplicates (by id or by
// artist + title), at most stMaxTracks.
func mergeAlbumTracks(albums []Album) []Track {
	out := []Track{}
	seen := map[string]bool{}
	for _, al := range albums {
		for _, t := range al.Tracks {
			k := normalize(t.Artist) + "|" + normalize(cleanTitle(t.Title))
			if t.ID == "" || seen[t.ID] || seen[k] {
				continue
			}
			seen[t.ID], seen[k] = true, true
			out = append(out, t)
			if len(out) == stMaxTracks {
				return out
			}
		}
	}
	return out
}

// soundtrackPrompt is the AI request for a title without a soundtrack
// album. It is still checked by looksLikeInjection and sent as data.
func soundtrackPrompt(f stFilm) string {
	kind, in := "фильма", "фильме"
	if f.Series {
		kind, in = "сериала", "сериале"
	}
	name := "«" + f.Title + "»"
	var extra []string
	if f.Original != "" && normalize(f.Original) != normalize(f.Title) {
		extra = append(extra, f.Original)
	}
	if f.Year > 0 {
		extra = append(extra, strconv.Itoa(f.Year))
	}
	if len(extra) > 0 {
		name += " (" + strings.Join(extra, ", ") + ")"
	}
	p := "Саундтрек " + kind + " " + name
	if len(f.Composers) > 0 {
		p += ", композитор " + strings.Join(f.Composers, ", ")
	}
	p += ": песни, которые звучат в " + in + ", и темы из его оригинальной музыки (можно несколько треков композитора)"
	if r := []rune(p); len(r) > 300 {
		p = string(r[:300])
	}
	return p
}

// stLang: the Cineko interface language (ru / en / kk).
func stLang(l string) string {
	switch l {
	case "en", "kk":
		return l
	}
	return "ru"
}

func soundtrackName(lang, title string) string {
	title = plain(title, 80)
	if lang == "en" {
		return title + " — soundtrack"
	}
	return title + " — саундтрек"
}

func soundtrackDesc(lang string, albums []Album) string {
	if len(albums) == 0 {
		switch lang {
		case "en":
			return "Picked by AI: songs from the film and its score."
		case "kk":
			return "ЖИ іріктеген: фильмдегі әндер мен оның музыкасы."
		}
		return "Подобрано ИИ: песни из фильма и музыка к нему."
	}
	names := make([]string, len(albums))
	for i, a := range albums {
		names[i] = "«" + a.Title + "»"
		if a.Artist != "" {
			names[i] += " — " + a.Artist
		}
	}
	prefix := map[string]string{"ru": "По альбомам: ", "en": "From the albums: ", "kk": "Альбомдар бойынша: "}[lang]
	return clip(prefix+strings.Join(names, "; "), 500)
}

// ---- store: the playlist made for each account and title ----

func migrateSoundtrack(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS soundtracks (
		user_id TEXT NOT NULL, media_id TEXT NOT NULL, playlist_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
		PRIMARY KEY (user_id, media_id))`)
	return err
}

// Soundtrack is the account's playlist for the title, while it still exists.
func (s *Store) Soundtrack(ctx context.Context, user, media string) (int64, bool) {
	var id int64
	err := s.db.QueryRowContext(ctx, `SELECT s.playlist_id FROM soundtracks s
		JOIN playlists p ON p.id=s.playlist_id AND p.user_id=s.user_id WHERE s.user_id=? AND s.media_id=?`, user, media).Scan(&id)
	return id, err == nil
}

func (s *Store) SetSoundtrack(ctx context.Context, user, media string, playlist int64) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO soundtracks(user_id, media_id, playlist_id, created_at) VALUES(?,?,?,?)
		ON CONFLICT(user_id, media_id) DO UPDATE SET playlist_id=excluded.playlist_id, created_at=excluded.created_at`,
		user, media, playlist, now())
	return err
}

// ---- handler ----

var reMediaID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// stLock serializes builds of the same playlist (a double press waits and
// then reuses the first one).
func (a *App) stLock(key string) func() {
	for {
		a.stMu.Lock()
		if a.stBusy == nil {
			a.stBusy = map[string]chan struct{}{}
		}
		ch, busy := a.stBusy[key]
		if !busy {
			ch = make(chan struct{})
			a.stBusy[key] = ch
			a.stMu.Unlock()
			return func() {
				a.stMu.Lock()
				delete(a.stBusy, key)
				a.stMu.Unlock()
				close(ch)
			}
		}
		a.stMu.Unlock()
		<-ch
	}
}

// fetchMedia reads the title from Cineko's API with the listener's session.
func (a *App) fetchMedia(ctx context.Context, r *http.Request, id, lang string) (*stMedia, error) {
	cl := "ru"
	if lang == "en" {
		cl = "en"
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.cfg.APIURL+"/api/v1/media/"+url.PathEscape(id)+"?lang="+cl, nil)
	if err != nil {
		return nil, err
	}
	forwardSession(req, r)
	resp, err := (&http.Client{Timeout: 15 * time.Second, Transport: a.auth.Transport}).Do(req)
	if err != nil {
		return nil, errStatus(503, "auth_unavailable", "Cineko недоступен")
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, errStatus(404, "not_found", "Фильм не найден")
	default:
		return nil, errStatus(502, "upstream", "Cineko не ответил, попробуйте ещё раз")
	}
	var m stMedia
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&m); err != nil || (m.Title == "" && m.OriginalTitle == "") {
		return nil, errStatus(502, "upstream", "Cineko не ответил, попробуйте ещё раз")
	}
	return &m, nil
}

// findSoundtrackAlbums searches the catalog and checks the best candidates'
// album pages (release year, track list).
func (a *App) findSoundtrackAlbums(ctx context.Context, f stFilm) []Album {
	var all []Album
	for _, q := range soundtrackQueries(f) {
		as, err := a.dz.SearchAlbums(ctx, q, 25)
		if err != nil {
			continue
		}
		all = append(all, as...)
	}
	// Search results have no release date: a lower bar here, the real one
	// once the album page (with the year) is loaded.
	cands := rankSoundtrackAlbums(all, f, stMin-15)
	var full []Album
	for i, c := range cands {
		if i == 6 {
			break
		}
		al, err := a.dz.Album(ctx, c.al.ID)
		if err != nil || len(al.Tracks) == 0 {
			continue
		}
		full = append(full, *al)
	}
	return pickSoundtrackAlbums(rankSoundtrackAlbums(full, f, stMin))
}

var errNoSoundtrack = errStatus(404, "no_soundtrack", "Саундтрек к этому фильму не нашёлся")

// aiSoundtrack asks the AI for the film's music (counted against the
// account's daily AI limit like an AI playlist).
func (a *App) aiSoundtrack(ctx context.Context, r *http.Request, u *User, f stFilm) ([]Track, error) {
	if !a.ai.Configured() {
		return nil, errNoSoundtrack
	}
	prompt := soundtrackPrompt(f)
	if looksLikeInjection(prompt) {
		return nil, errNoSoundtrack
	}
	day := aiDay(time.Now())
	if err := a.takeAI(ctx, u.ID, day); err != nil {
		switch {
		case errors.Is(err, errAIBudget):
			return nil, errStatus(429, "ai_budget", "Лимит ИИ на сегодня исчерпан")
		case errors.Is(err, errAILimit):
			return nil, errStatus(429, "ai_limit", "Лимит ИИ-подборок на сегодня исчерпан")
		}
		return nil, err
	}
	pl, tokens, err := a.ai.Generate(ctx, prompt, nil, nil, a.aiSettings(r).temperature("precise"))
	a.st.AddAITokens(ctx, u.ID, day, tokens)
	if err != nil {
		a.st.RefundAI(ctx, u.ID, day)
		a.log.Warn("ai soundtrack", "err", err.Error(), "tokens", tokens)
		return nil, errStatus(502, "ai_failed", "ИИ не ответил, попробуйте ещё раз")
	}
	a.log.Info("ai soundtrack", "tokens", tokens, "refused", pl.Refused)
	if pl.Refused {
		return nil, errNoSoundtrack
	}
	return a.matchAITracks(ctx, pl.Tracks), nil
}

// hSoundtrack: POST {media, lang} → {id, created, source: "album"|"ai"|"",
// name}. An existing playlist for this account and title is reused
// (created: false). The build goes on if the listener leaves the page, so
// the next press finds it ready.
func (a *App) hSoundtrack(w http.ResponseWriter, r *http.Request, u *User) error {
	var b struct {
		Media string `json:"media"`
		Lang  string `json:"lang"`
	}
	if err := readJSON(r, &b); err != nil {
		return err
	}
	if !reMediaID.MatchString(b.Media) {
		return errStatus(400, "bad_media", "Некорректный id")
	}
	media, lang := strings.ToLower(b.Media), stLang(b.Lang)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 3*time.Minute)
	defer cancel()
	unlock := a.stLock(u.ID + "|" + media)
	defer unlock()
	if id, ok := a.st.Soundtrack(ctx, u.ID, media); ok {
		writeJSON(w, 200, map[string]any{"id": id, "created": false, "source": ""})
		return nil
	}
	m, err := a.fetchMedia(ctx, r, media, lang)
	if err != nil {
		return err
	}
	f := filmFromMedia(*m)
	if len(f.titles()) == 0 {
		return errNoSoundtrack
	}
	albums := a.findSoundtrackAlbums(ctx, f)
	tracks, source := mergeAlbumTracks(albums), "album"
	if len(tracks) == 0 {
		albums, source = nil, "ai"
		if tracks, err = a.aiSoundtrack(ctx, r, u, f); err != nil {
			return err
		}
	}
	rows := trackRows(tracks)
	if len(rows) == 0 {
		return errNoSoundtrack
	}
	name := soundtrackName(lang, f.Title)
	id, err := a.st.CreatePlaylist(ctx, u.ID, name, soundtrackDesc(lang, albums))
	if err != nil {
		return err
	}
	if err := a.st.AddToPlaylist(ctx, u.ID, id, rows); err != nil {
		return err
	}
	if err := a.st.SetSoundtrack(ctx, u.ID, media, id); err != nil {
		return err
	}
	a.log.Info("soundtrack playlist", "source", source, "tracks", len(rows))
	writeJSON(w, 201, map[string]any{"id": id, "created": true, "source": source, "name": name})
	return nil
}
