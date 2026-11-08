package main

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// The "choose a source" dialog: one provider per request (the web app loads
// YouTube and zaycev in parallel, one tab each), for any track — catalog
// ("dz:"), imported / AI ("yq:", known only by artist + title) or a plain
// YouTube / zaycev upload. The chosen recording is saved for "dz:" and "yq:"
// tracks (the ids playback looks matches up by); other tracks just play it.

// sourceTrack: the track named by ?id=&artist=&title=&duration=&album=.
// Catalog tracks come from the catalog; the rest from the query.
func (a *App) sourceTrack(ctx context.Context, q map[string][]string) (*Track, error) {
	get := func(k string) string {
		if v := q[k]; len(v) > 0 {
			return strings.TrimSpace(v[0])
		}
		return ""
	}
	id := get("id")
	if rest, ok := strings.CutPrefix(id, "dz:"); ok {
		n, err := strconv.ParseInt(rest, 10, 64)
		if err != nil || n < 0 {
			return nil, errStatus(400, "bad_request", "Некорректный трек")
		}
		return a.dz.Track(ctx, n)
	}
	t := &Track{ID: id, Artist: get("artist"), Title: get("title"), Album: get("album")}
	t.Duration, _ = strconv.Atoi(get("duration"))
	if t.Title == "" || !validTrackID(id) {
		return nil, errStatus(400, "bad_request", "Некорректный трек")
	}
	if strings.HasPrefix(id, "yq:") && yqID(t.Artist, t.Title) != id {
		return nil, errStatus(400, "bad_request", "Некорректный трек")
	}
	return t, nil
}

// matchKey: the id a track's chosen recording is stored under ("" = can't be saved).
func matchKey(id string) string {
	if strings.HasPrefix(id, "dz:") || yqRe.MatchString(id) {
		return id
	}
	return ""
}

// hSources: GET /sources/{provider} (youtube | zaycev) →
// {current, torrent?, saved, items}.
func (a *App) hSources(w http.ResponseWriter, r *http.Request, u *User) error {
	t, err := a.sourceTrack(r.Context(), r.URL.Query())
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	var items any
	switch r.PathValue("provider") {
	case "youtube":
		c, err := a.yt.Candidates(ctx, &Track{ID: t.ID, Artist: t.Artist, Title: cleanTitle(t.Title), Version: t.Version, Album: t.Album, Duration: t.Duration})
		if err != nil {
			return err
		}
		if c == nil {
			c = []Candidate{}
		}
		items = c
	case "zaycev":
		z, err := a.zv.Ranked(ctx, t)
		if err != nil {
			return err
		}
		if len(z) > 12 {
			z = z[:12]
		}
		items = z
	default:
		return errStatus(404, "not_found", "Нет такого источника")
	}
	out := map[string]any{"current": "", "saved": false, "items": items}
	if key := matchKey(t.ID); key != "" {
		out["saved"] = true
		if v, ok := a.st.Match(r.Context(), key); ok {
			out["current"] = v
		}
		if src, ok := a.st.ManualTorrent(r.Context(), key); ok {
			out["torrent"] = src
		}
	}
	writeJSON(w, 200, out)
	return nil
}

// hSourceMatch: PUT {trackId, artist, title, value} saves the recording
// (YouTube video id or "zv:<n>") for a "dz:" / "yq:" track. A listener's
// "always from this torrent" choice would win over it, so it is dropped.
func (a *App) hSourceMatch(w http.ResponseWriter, r *http.Request, u *User) error {
	var b struct {
		TrackID string `json:"trackId"`
		Artist  string `json:"artist"`
		Title   string `json:"title"`
		Value   string `json:"value"`
	}
	if err := readJSON(r, &b); err != nil {
		return err
	}
	key := matchKey(b.TrackID)
	if key == "" || (strings.HasPrefix(key, "dz:") && !validTrackID(key)) {
		return errStatus(400, "bad_request", "Для этого трека запись не сохраняется")
	}
	if strings.HasPrefix(key, "yq:") && yqID(b.Artist, b.Title) != key {
		return errStatus(400, "bad_request", "Некорректный трек")
	}
	if _, zv := zvMatch(b.Value); !zv && !validVideoID(b.Value) {
		return errStatus(400, "bad_request", "Некорректный источник")
	}
	if err := a.st.SetMatch(r.Context(), key, b.Value, true); err != nil {
		return err
	}
	a.st.ForgetTorrentMatch(r.Context(), key)
	w.WriteHeader(204)
	return nil
}

// hResolveQuery: GET /resolveq?id=&artist=&title=&duration= finds (and
// caches) the recording of a "yq:" track ahead of playback, like /resolve
// does for catalog tracks: the player waits on it before pointing the audio
// element at /ytq, which then answers at once.
func (a *App) hResolveQuery(w http.ResponseWriter, r *http.Request, u *User) error {
	q := r.URL.Query()
	id := q.Get("id")
	t := &Track{ID: id, Artist: q.Get("artist"), Title: q.Get("title")}
	t.Duration, _ = strconv.Atoi(q.Get("duration"))
	if !yqRe.MatchString(id) || t.Title == "" || yqID(t.Artist, t.Title) != id {
		return errStatus(400, "bad_request", "Некорректный трек")
	}
	if _, ok := a.st.ManualTorrent(r.Context(), id); ok {
		writeJSON(w, 200, map[string]any{"videoId": "", "cached": false})
		return nil
	}
	v, ok := a.st.Match(r.Context(), id)
	if !ok || memo.isBad(id, v) {
		var err error
		if v, err = a.findYT(r.Context(), t); err != nil {
			return err
		}
		_ = a.st.SetMatch(r.Context(), id, v, false)
	}
	if _, zv := zvMatch(v); zv {
		writeJSON(w, 200, map[string]any{"videoId": v, "cached": false})
		return nil
	}
	a.cacheAudio(v)
	_, _, cached := a.cacheLookup(v)
	writeJSON(w, 200, map[string]any{"videoId": v, "cached": cached})
	return nil
}
