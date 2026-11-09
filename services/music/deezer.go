package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

// Deezer public API client (https://developers.deezer.com/api, no key).
// Quota: 50 requests / 5 s per IP, so the client spaces its calls and caches
// every answer.

type Deezer struct {
	base  string
	hc    *http.Client
	cache *ttlCache
	mu    sync.Mutex
	next  time.Time
}

var errDeezerNotFound = errors.New("deezer: not found")

func newDeezer(base string, hc *http.Client) *Deezer {
	return &Deezer{base: base, hc: hc, cache: newTTLCache(4000)}
}

// wait spaces requests ≥ 110 ms apart (≈ 45 per 5 s).
func (d *Deezer) wait(ctx context.Context) error {
	d.mu.Lock()
	t := time.Now()
	if d.next.Before(t) {
		d.next = t
	}
	at := d.next
	d.next = d.next.Add(110 * time.Millisecond)
	d.mu.Unlock()
	if delay := time.Until(at); delay > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
	return nil
}

func (d *Deezer) get(ctx context.Context, path string, q url.Values, ttl time.Duration, out any) error {
	key := path + "?" + q.Encode()
	if b, ok := d.cache.get(key); ok {
		return json.Unmarshal(b, out)
	}
	var body []byte
	for attempt := 0; attempt < 3; attempt++ {
		if err := d.wait(ctx); err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.base+path+"?"+q.Encode(), nil)
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Accept-Language", "ru")
		resp, err := d.hc.Do(req)
		if err != nil {
			return fmt.Errorf("deezer: %w", shortErr(err))
		}
		body, err = io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		if err != nil {
			return fmt.Errorf("deezer: read: %w", err)
		}
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("deezer: HTTP %d", resp.StatusCode)
		}
		var e struct {
			Error *struct {
				Type    string `json:"type"`
				Message string `json:"message"`
				Code    int    `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(body, &e) == nil && e.Error != nil {
			switch e.Error.Code {
			case 4: // quota exceeded: back off and retry
				time.Sleep(time.Duration(attempt+1) * 1500 * time.Millisecond)
				continue
			case 800, 801, 802:
				return errDeezerNotFound
			}
			return fmt.Errorf("deezer: %s (%d)", e.Error.Message, e.Error.Code)
		}
		break
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("deezer: decode: %w", err)
	}
	d.cache.set(key, body, ttl)
	return nil
}

// ---- raw Deezer objects ----

type dzArtist struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	PictureMedium string `json:"picture_medium"`
	PictureBig    string `json:"picture_big"`
	PictureXL     string `json:"picture_xl"`
	NbAlbum       int    `json:"nb_album"`
	NbFan         int    `json:"nb_fan"`
	Role          string `json:"role"`
}

type dzAlbum struct {
	ID          int64     `json:"id"`
	Title       string    `json:"title"`
	CoverMedium string    `json:"cover_medium"`
	CoverBig    string    `json:"cover_big"`
	CoverXL     string    `json:"cover_xl"`
	ReleaseDate string    `json:"release_date"`
	RecordType  string    `json:"record_type"`
	NbTracks    int       `json:"nb_tracks"`
	Duration    int       `json:"duration"`
	Label       string    `json:"label"`
	Fans        int       `json:"fans"`
	Explicit    bool      `json:"explicit_lyrics"`
	Artist      *dzArtist `json:"artist"`
	Genres      *struct {
		Data []struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
	} `json:"genres"`
	Contributors []dzArtist `json:"contributors"`
	Tracks       *struct {
		Data []dzTrack `json:"data"`
	} `json:"tracks"`
}

type dzTrack struct {
	ID            int64      `json:"id"`
	Readable      *bool      `json:"readable"`
	Title         string     `json:"title"`
	TitleShort    string     `json:"title_short"`
	TitleVersion  string     `json:"title_version"`
	Duration      int        `json:"duration"`
	Rank          int        `json:"rank"`
	Explicit      bool       `json:"explicit_lyrics"`
	ISRC          string     `json:"isrc"`
	TrackPosition int        `json:"track_position"`
	DiskNumber    int        `json:"disk_number"`
	Artist        *dzArtist  `json:"artist"`
	Album         *dzAlbum   `json:"album"`
	Contributors  []dzArtist `json:"contributors"`
}

type dzPlaylist struct {
	ID            int64  `json:"id"`
	Title         string `json:"title"`
	Description   string `json:"description"`
	PictureMedium string `json:"picture_medium"`
	PictureBig    string `json:"picture_big"`
	PictureXL     string `json:"picture_xl"`
	NbTracks      int    `json:"nb_tracks"`
	Fans          int    `json:"fans"`
	User          *struct {
		Name string `json:"name"`
	} `json:"user"`
	Creator *struct {
		Name string `json:"name"`
	} `json:"creator"`
	Tracks *struct {
		Data []dzTrack `json:"data"`
	} `json:"tracks"`
}

type dzList[T any] struct {
	Data  []T    `json:"data"`
	Total int    `json:"total"`
	Next  string `json:"next"`
}

// ---- normalized objects (what the web app sees) ----

type ArtistRef struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// Track is the app's track. ID: "dz:<deezer id>" for catalog tracks,
// "t:<hash>:<file>[:<start ms>]" for torrent files (Src set).
type Track struct {
	ID       string      `json:"id"`
	Title    string      `json:"title"`
	Version  string      `json:"version,omitempty"`
	Artist   string      `json:"artist"`
	ArtistID int64       `json:"artistId,omitempty"`
	Artists  []ArtistRef `json:"artists,omitempty"`
	Album    string      `json:"album,omitempty"`
	AlbumID  int64       `json:"albumId,omitempty"`
	Cover    string      `json:"cover,omitempty"`
	CoverBig string      `json:"coverBig,omitempty"`
	Duration int         `json:"duration"`
	Explicit bool        `json:"explicit,omitempty"`
	Position int         `json:"position,omitempty"`
	Disk     int         `json:"disk,omitempty"`
	Src      *TorrentSrc `json:"src,omitempty"`
}

type TorrentSrc struct {
	Hash     string `json:"hash"`
	File     int    `json:"file"`
	Start    int64  `json:"start,omitempty"` // ms (CUE tracks)
	End      int64  `json:"end,omitempty"`   // ms, 0 = to the end of the file
	Ext      string `json:"ext"`
	Lossless bool   `json:"lossless,omitempty"`
}

type Album struct {
	ID       int64       `json:"id"`
	Title    string      `json:"title"`
	Artist   string      `json:"artist"`
	ArtistID int64       `json:"artistId,omitempty"`
	Artists  []ArtistRef `json:"artists,omitempty"`
	Cover    string      `json:"cover,omitempty"`
	CoverBig string      `json:"coverBig,omitempty"`
	Year     string      `json:"year,omitempty"`
	Date     string      `json:"date,omitempty"`
	Type     string      `json:"type,omitempty"`
	NbTracks int         `json:"nbTracks,omitempty"`
	Duration int         `json:"duration,omitempty"`
	Label    string      `json:"label,omitempty"`
	Genres   []string    `json:"genres,omitempty"`
	Fans     int         `json:"fans,omitempty"`
	Explicit bool        `json:"explicit,omitempty"`
	Tracks   []Track     `json:"tracks,omitempty"`
}

type Artist struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Picture    string `json:"picture,omitempty"`
	PictureBig string `json:"pictureBig,omitempty"`
	Fans       int    `json:"fans,omitempty"`
	Albums     int    `json:"albums,omitempty"`
}

type DzPlaylist struct {
	ID          int64   `json:"id"`
	Title       string  `json:"title"`
	Description string  `json:"description,omitempty"`
	Picture     string  `json:"picture,omitempty"`
	PictureBig  string  `json:"pictureBig,omitempty"`
	Count       int     `json:"count,omitempty"`
	Fans        int     `json:"fans,omitempty"`
	Owner       string  `json:"owner,omitempty"`
	Tracks      []Track `json:"tracks,omitempty"`
}

func normArtist(a *dzArtist) Artist {
	if a == nil {
		return Artist{}
	}
	return Artist{ID: a.ID, Name: a.Name, Picture: a.PictureMedium, PictureBig: firstNonEmpty(a.PictureXL, a.PictureBig),
		Fans: a.NbFan, Albums: a.NbAlbum}
}

// normTrack converts a Deezer track; album fills in a missing album (album
// track lists omit it).
func normTrack(t dzTrack, album *dzAlbum) Track {
	out := Track{ID: "dz:" + strconv.FormatInt(t.ID, 10), Title: firstNonEmpty(t.TitleShort, t.Title), Version: t.TitleVersion,
		Duration: t.Duration, Explicit: t.Explicit, Position: t.TrackPosition, Disk: t.DiskNumber}
	if t.Artist != nil {
		out.Artist, out.ArtistID = t.Artist.Name, t.Artist.ID
	}
	for _, c := range t.Contributors {
		out.Artists = append(out.Artists, ArtistRef{ID: c.ID, Name: c.Name})
	}
	al := t.Album
	if al == nil {
		al = album
	}
	if al != nil {
		out.Album, out.AlbumID, out.Cover, out.CoverBig = al.Title, al.ID, al.CoverMedium, firstNonEmpty(al.CoverXL, al.CoverBig)
	}
	return out
}

func normTracks(ts []dzTrack, album *dzAlbum) []Track {
	out := make([]Track, 0, len(ts))
	for _, t := range ts {
		if t.Readable != nil && !*t.Readable && t.Duration == 0 {
			continue
		}
		out = append(out, normTrack(t, album))
	}
	return out
}

func normAlbum(a dzAlbum) Album {
	out := Album{ID: a.ID, Title: a.Title, Cover: a.CoverMedium, CoverBig: firstNonEmpty(a.CoverXL, a.CoverBig),
		Date: a.ReleaseDate, Type: a.RecordType, NbTracks: a.NbTracks, Duration: a.Duration, Label: a.Label, Fans: a.Fans, Explicit: a.Explicit}
	if len(a.ReleaseDate) >= 4 {
		out.Year = a.ReleaseDate[:4]
	}
	if a.Artist != nil {
		out.Artist, out.ArtistID = a.Artist.Name, a.Artist.ID
	}
	for _, c := range a.Contributors {
		out.Artists = append(out.Artists, ArtistRef{ID: c.ID, Name: c.Name})
	}
	if a.Genres != nil {
		for _, g := range a.Genres.Data {
			out.Genres = append(out.Genres, g.Name)
		}
	}
	return out
}

func normAlbums(as []dzAlbum) []Album {
	out := make([]Album, 0, len(as))
	for _, a := range as {
		out = append(out, normAlbum(a))
	}
	return out
}

func normArtists(as []dzArtist) []Artist {
	out := make([]Artist, 0, len(as))
	for i := range as {
		out = append(out, normArtist(&as[i]))
	}
	return out
}

func normPlaylist(p dzPlaylist) DzPlaylist {
	out := DzPlaylist{ID: p.ID, Title: p.Title, Description: p.Description, Picture: p.PictureMedium,
		PictureBig: firstNonEmpty(p.PictureXL, p.PictureBig), Count: p.NbTracks, Fans: p.Fans}
	if p.User != nil {
		out.Owner = p.User.Name
	} else if p.Creator != nil {
		out.Owner = p.Creator.Name
	}
	return out
}

func normPlaylists(ps []dzPlaylist) []DzPlaylist {
	out := make([]DzPlaylist, 0, len(ps))
	for _, p := range ps {
		out = append(out, normPlaylist(p))
	}
	return out
}

// ---- calls ----

const (
	ttlShort = 30 * time.Minute
	ttlLong  = 12 * time.Hour
)

type Chart struct {
	Tracks    []Track      `json:"tracks"`
	Albums    []Album      `json:"albums"`
	Artists   []Artist     `json:"artists"`
	Playlists []DzPlaylist `json:"playlists"`
}

func (d *Deezer) Chart(ctx context.Context, genre int64) (*Chart, error) {
	var raw struct {
		Tracks    dzList[dzTrack]    `json:"tracks"`
		Albums    dzList[dzAlbum]    `json:"albums"`
		Artists   dzList[dzArtist]   `json:"artists"`
		Playlists dzList[dzPlaylist] `json:"playlists"`
	}
	q := url.Values{"limit": {"50"}}
	if err := d.get(ctx, "/chart/"+strconv.FormatInt(genre, 10), q, ttlShort, &raw); err != nil {
		return nil, err
	}
	return &Chart{Tracks: normTracks(raw.Tracks.Data, nil), Albums: normAlbums(raw.Albums.Data),
		Artists: normArtists(raw.Artists.Data), Playlists: normPlaylists(raw.Playlists.Data)}, nil
}

type Genre struct {
	ID      int64  `json:"id"`
	Name    string `json:"name"`
	Picture string `json:"picture"`
}

func (d *Deezer) Genres(ctx context.Context) ([]Genre, error) {
	var raw dzList[struct {
		ID            int64  `json:"id"`
		Name          string `json:"name"`
		PictureMedium string `json:"picture_medium"`
	}]
	if err := d.get(ctx, "/genre", url.Values{}, ttlLong, &raw); err != nil {
		return nil, err
	}
	out := []Genre{}
	for _, g := range raw.Data {
		if g.ID == 0 {
			continue // "All"
		}
		out = append(out, Genre{ID: g.ID, Name: g.Name, Picture: g.PictureMedium})
	}
	return out, nil
}

type SearchResult struct {
	Tracks    []Track      `json:"tracks"`
	Albums    []Album      `json:"albums"`
	Artists   []Artist     `json:"artists"`
	Playlists []DzPlaylist `json:"playlists"`
}

func (d *Deezer) Search(ctx context.Context, q string) (*SearchResult, error) {
	out := &SearchResult{Tracks: []Track{}, Albums: []Album{}, Artists: []Artist{}, Playlists: []DzPlaylist{}}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	run := func(f func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := f(); err != nil && !errors.Is(err, errDeezerNotFound) {
				mu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
			}
		}()
	}
	run(func() error {
		var r dzList[dzTrack]
		if err := d.get(ctx, "/search/track", url.Values{"q": {q}, "limit": {"40"}}, ttlShort, &r); err != nil {
			return err
		}
		out.Tracks = normTracks(r.Data, nil)
		return nil
	})
	run(func() error {
		var r dzList[dzAlbum]
		if err := d.get(ctx, "/search/album", url.Values{"q": {q}, "limit": {"24"}}, ttlShort, &r); err != nil {
			return err
		}
		out.Albums = normAlbums(r.Data)
		return nil
	})
	run(func() error {
		var r dzList[dzArtist]
		if err := d.get(ctx, "/search/artist", url.Values{"q": {q}, "limit": {"18"}}, ttlShort, &r); err != nil {
			return err
		}
		out.Artists = normArtists(r.Data)
		return nil
	})
	run(func() error {
		var r dzList[dzPlaylist]
		if err := d.get(ctx, "/search/playlist", url.Values{"q": {q}, "limit": {"18"}}, ttlShort, &r); err != nil {
			return err
		}
		out.Playlists = normPlaylists(r.Data)
		return nil
	})
	wg.Wait()
	if firstErr != nil && len(out.Tracks) == 0 && len(out.Albums) == 0 && len(out.Artists) == 0 {
		return nil, firstErr
	}
	return out, nil
}

type ArtistPage struct {
	Artist    Artist       `json:"artist"`
	Top       []Track      `json:"top"`
	Albums    []Album      `json:"albums"`
	Related   []Artist     `json:"related"`
	Playlists []DzPlaylist `json:"playlists"`
}

func (d *Deezer) Artist(ctx context.Context, id int64) (*ArtistPage, error) {
	ids := strconv.FormatInt(id, 10)
	var a dzArtist
	if err := d.get(ctx, "/artist/"+ids, url.Values{}, ttlLong, &a); err != nil {
		return nil, err
	}
	out := &ArtistPage{Artist: normArtist(&a), Top: []Track{}, Albums: []Album{}, Related: []Artist{}, Playlists: []DzPlaylist{}}
	var wg sync.WaitGroup
	wg.Add(4)
	go func() {
		defer wg.Done()
		var r dzList[dzTrack]
		if d.get(ctx, "/artist/"+ids+"/top", url.Values{"limit": {"20"}}, ttlShort, &r) == nil {
			out.Top = normTracks(r.Data, nil)
		}
	}()
	go func() {
		defer wg.Done()
		var r dzList[dzAlbum]
		if d.get(ctx, "/artist/"+ids+"/albums", url.Values{"limit": {"100"}}, ttlLong, &r) == nil {
			out.Albums = normAlbums(r.Data)
			for i := range out.Albums {
				if out.Albums[i].ArtistID == 0 {
					out.Albums[i].Artist, out.Albums[i].ArtistID = a.Name, a.ID
				}
			}
		}
	}()
	go func() {
		defer wg.Done()
		var r dzList[dzArtist]
		if d.get(ctx, "/artist/"+ids+"/related", url.Values{"limit": {"20"}}, ttlLong, &r) == nil {
			out.Related = normArtists(r.Data)
		}
	}()
	go func() {
		defer wg.Done()
		var r dzList[dzPlaylist]
		if d.get(ctx, "/artist/"+ids+"/playlists", url.Values{"limit": {"12"}}, ttlLong, &r) == nil {
			out.Playlists = normPlaylists(r.Data)
		}
	}()
	wg.Wait()
	return out, nil
}

// ArtistTracks is everything the artist released: albums, then singles and
// EPs (newest first, album order inside), each song once. Compilations are
// left out (mostly other artists).
func (d *Deezer) ArtistTracks(ctx context.Context, id int64) ([]Track, error) {
	ids := strconv.FormatInt(id, 10)
	var r dzList[dzAlbum]
	if err := d.get(ctx, "/artist/"+ids+"/albums", url.Values{"limit": {"100"}}, ttlLong, &r); err != nil {
		return nil, err
	}
	var list []dzAlbum
	for _, a := range r.Data {
		if a.RecordType != "compile" {
			list = append(list, a)
		}
	}
	rank := func(t string) int {
		if t == "album" || t == "" {
			return 0
		}
		return 1
	}
	sort.SliceStable(list, func(i, j int) bool {
		if ri, rj := rank(list[i].RecordType), rank(list[j].RecordType); ri != rj {
			return ri < rj
		}
		return list[i].ReleaseDate > list[j].ReleaseDate
	})
	if len(list) > 60 {
		list = list[:60]
	}
	albums := make([]*Album, len(list))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	for i, a := range list {
		wg.Add(1)
		go func(i int, aid int64) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if al, err := d.Album(ctx, aid); err == nil {
				albums[i] = al
			}
		}(i, a.ID)
	}
	wg.Wait()
	out := []Track{}
	seen := map[string]bool{}
	for _, al := range albums {
		if al == nil {
			continue
		}
		for _, t := range al.Tracks {
			k := normalize(t.Title + " " + t.Version)
			if k == "" || seen[k] {
				continue
			}
			seen[k] = true
			out = append(out, t)
		}
	}
	return out, nil
}

func (d *Deezer) ArtistRadio(ctx context.Context, id int64) ([]Track, error) {
	var r dzList[dzTrack]
	// Radio is meant to vary: cache briefly.
	if err := d.get(ctx, "/artist/"+strconv.FormatInt(id, 10)+"/radio", url.Values{"limit": {"50"}}, 3*time.Minute, &r); err != nil {
		return nil, err
	}
	return normTracks(r.Data, nil), nil
}

func (d *Deezer) ArtistTop(ctx context.Context, id int64, limit int) ([]Track, error) {
	var r dzList[dzTrack]
	if err := d.get(ctx, "/artist/"+strconv.FormatInt(id, 10)+"/top", url.Values{"limit": {strconv.Itoa(limit)}}, ttlShort, &r); err != nil {
		return nil, err
	}
	return normTracks(r.Data, nil), nil
}

func (d *Deezer) Album(ctx context.Context, id int64) (*Album, error) {
	ids := strconv.FormatInt(id, 10)
	var a dzAlbum
	if err := d.get(ctx, "/album/"+ids, url.Values{}, ttlLong, &a); err != nil {
		return nil, err
	}
	tracks := []dzTrack{}
	if a.Tracks != nil {
		tracks = a.Tracks.Data
	}
	// The embedded list is capped (25 on some albums); fetch the rest.
	if a.NbTracks > len(tracks) {
		var r dzList[dzTrack]
		if d.get(ctx, "/album/"+ids+"/tracks", url.Values{"limit": {"500"}}, ttlLong, &r) == nil && len(r.Data) > len(tracks) {
			tracks = r.Data
		}
	}
	out := normAlbum(a)
	out.Tracks = normTracks(tracks, &a)
	for i := range out.Tracks {
		if out.Tracks[i].Position == 0 {
			out.Tracks[i].Position = i + 1
		}
	}
	return &out, nil
}

func (d *Deezer) Playlist(ctx context.Context, id int64) (*DzPlaylist, error) {
	ids := strconv.FormatInt(id, 10)
	var p dzPlaylist
	if err := d.get(ctx, "/playlist/"+ids, url.Values{}, ttlShort, &p); err != nil {
		return nil, err
	}
	out := normPlaylist(p)
	var tracks []dzTrack
	if p.Tracks != nil {
		tracks = p.Tracks.Data
	}
	if p.NbTracks > len(tracks) {
		var r dzList[dzTrack]
		if d.get(ctx, "/playlist/"+ids+"/tracks", url.Values{"limit": {"300"}}, ttlShort, &r) == nil && len(r.Data) > len(tracks) {
			tracks = r.Data
		}
	}
	out.Tracks = normTracks(tracks, nil)
	return &out, nil
}

func (d *Deezer) Track(ctx context.Context, id int64) (*Track, error) {
	var t dzTrack
	if err := d.get(ctx, "/track/"+strconv.FormatInt(id, 10), url.Values{}, ttlLong, &t); err != nil {
		return nil, err
	}
	out := normTrack(t, nil)
	return &out, nil
}

// SearchTrack finds the catalog track for "artist title" (used to attach
// covers and links to torrent files).
func (d *Deezer) SearchTracks(ctx context.Context, q string, limit int) ([]Track, error) {
	var r dzList[dzTrack]
	if err := d.get(ctx, "/search/track", url.Values{"q": {q}, "limit": {strconv.Itoa(limit)}}, ttlShort, &r); err != nil {
		return nil, err
	}
	return normTracks(r.Data, nil), nil
}

// SearchAlbums: catalog albums for q (no release dates: Album has them).
func (d *Deezer) SearchAlbums(ctx context.Context, q string, limit int) ([]Album, error) {
	var r dzList[dzAlbum]
	if err := d.get(ctx, "/search/album", url.Values{"q": {q}, "limit": {strconv.Itoa(limit)}}, ttlShort, &r); err != nil {
		return nil, err
	}
	return normAlbums(r.Data), nil
}

func shortErr(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// ---- tiny TTL cache ----

type ttlEntry struct {
	val []byte
	exp time.Time
}

type ttlCache struct {
	mu  sync.Mutex
	m   map[string]ttlEntry
	cap int
}

func newTTLCache(capacity int) *ttlCache { return &ttlCache{m: map[string]ttlEntry{}, cap: capacity} }

func (c *ttlCache) get(k string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok || time.Now().After(e.exp) {
		return nil, false
	}
	return e.val, true
}

func (c *ttlCache) set(k string, v []byte, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= c.cap {
		t := time.Now()
		for key, e := range c.m {
			if t.After(e.exp) || len(c.m) >= c.cap*3/4 {
				delete(c.m, key)
			}
			if len(c.m) < c.cap*3/4 {
				break
			}
		}
	}
	c.m[k] = ttlEntry{val: v, exp: time.Now().Add(ttl)}
}

// normalize lowercases, folds ё→е and keeps letters/digits separated by
// single spaces (matching titles across Deezer, YouTube and file names).
func normalize(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, "ё", "е")
	var b strings.Builder
	space := true
	for _, r := range s {
		if isAlnum(r) {
			b.WriteRune(r)
			space = false
		} else if !space {
			b.WriteByte(' ')
			space = true
		}
	}
	return strings.TrimSpace(b.String())
}

func isAlnum(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }
