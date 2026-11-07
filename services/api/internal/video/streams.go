package video

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"martytv/api/internal/playback"
)

// playback.VideoProvider implementation: formats of a video for the
// stream proxy (internal/playback/video.go).

var _ playback.VideoProvider = (*Service)(nil)

func (s *Service) VideoStreams(ctx context.Context, id string, fresh bool) (*playback.VideoStreams, error) {
	if !ValidVideoID(id) {
		return nil, playback.ErrVideoNotFound
	}
	v, err := s.client.Video(ctx, id, fresh)
	if err != nil {
		return nil, providerErr(err)
	}
	return s.toStreams(v), nil
}

func providerErr(err error) error {
	switch {
	case errors.Is(err, ErrNotFound):
		return playback.ErrVideoNotFound
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	}
	return errors.Join(playback.ErrVideoUnavailable, err)
}

func (s *Service) VideoQuality(ctx context.Context, profileID *string) int {
	if profileID == nil || s.prefs == nil {
		return DefaultQuality
	}
	return s.prefs(ctx, *profileID).Quality
}

func (s *Service) VideoResume(ctx context.Context, profileID, videoID string) float64 {
	p, err := s.st.progress(ctx, profileID, videoID)
	if err != nil || p == nil || p.Finished || p.PositionSeconds < minResumeSeconds {
		return 0
	}
	return p.PositionSeconds
}

func (s *Service) VideoHTTP() *http.Client     { return s.client.HTTP() }
func (s *Service) VideoOrigin(u *url.URL) bool { return s.client.SameOrigin(u) }

var codecsRe = regexp.MustCompile(`codecs="([^"]+)"`)

func mimeAndCodecs(t string) (string, string) {
	mime := strings.TrimSpace(strings.SplitN(t, ";", 2)[0])
	codecs := ""
	if m := codecsRe.FindStringSubmatch(t); m != nil {
		codecs = strings.TrimSpace(m[1])
	}
	return strings.ToLower(mime), codecs
}

// byteRange parses "741-1228".
func byteRange(s string) (int64, int64, bool) {
	a, b, ok := strings.Cut(s, "-")
	if !ok {
		return 0, 0, false
	}
	x, err1 := strconv.ParseInt(a, 10, 64)
	y, err2 := strconv.ParseInt(b, 10, 64)
	if err1 != nil || err2 != nil || x < 0 || y < x {
		return 0, 0, false
	}
	return x, y, true
}

func sizeOf(f ivFormat) (int, int) {
	w, h, ok := strings.Cut(f.Size, "x")
	if !ok {
		return 0, 0
	}
	wi, _ := strconv.Atoi(w)
	hi, _ := strconv.Atoi(h)
	return wi, hi
}

// toStreams keeps what Cineko can play everywhere: H.264 fMP4 video and
// AAC fMP4 audio (adaptive, with init+index ranges) and muxed MP4.
// VP9/AV1/Opus are skipped (old TVs). Stream URLs must be on the Invidious
// origin (local=true); anything else is dropped.
func (s *Service) toStreams(v *ivVideo) *playback.VideoStreams {
	out := &playback.VideoStreams{ID: v.VideoID, Title: v.Title, Duration: float64(v.LengthSeconds),
		Live: v.LiveNow || v.IsUpcoming || v.LengthSeconds == 0}
	onOrigin := func(raw string) (string, bool) {
		u, err := s.client.Resolve(raw)
		if err != nil {
			return "", false
		}
		return u.String(), true
	}
	for _, f := range v.AdaptiveFormats {
		mime, codecs := mimeAndCodecs(f.Type)
		u, ok := onOrigin(f.URL)
		if !ok {
			continue
		}
		_, initEnd, ok1 := byteRange(f.Init)
		ixFrom, ixTo, ok2 := byteRange(f.Index)
		if !ok1 || !ok2 || ixFrom <= initEnd {
			continue
		}
		w, h := sizeOf(f)
		t := playback.VideoTrack{Itag: int(f.Itag), Width: w, Height: h, FPS: f.FPS, Bandwidth: int64(f.Bitrate),
			Codecs: codecs, Mime: mime, URL: u, InitEnd: initEnd, IndexFrom: ixFrom, IndexTo: ixTo, Size: int64(f.Clen)}
		switch {
		case mime == "video/mp4" && strings.HasPrefix(codecs, "avc1") && h > 0:
			out.Video = append(out.Video, t)
		case mime == "audio/mp4" && strings.HasPrefix(codecs, "mp4a"):
			out.Audio = append(out.Audio, t)
		}
	}
	// The player takes the first AAC track: the viewer's language first.
	sortAudio(out.Audio, s.client.lang)
	for _, f := range v.FormatStreams {
		mime, codecs := mimeAndCodecs(f.Type)
		u, ok := onOrigin(f.URL)
		if !ok || mime != "video/mp4" {
			continue
		}
		w, h := sizeOf(f)
		out.Progressive = append(out.Progressive, playback.VideoTrack{Itag: int(f.Itag), Width: w, Height: h, FPS: f.FPS,
			Bandwidth: int64(f.Bitrate), Codecs: codecs, Mime: mime, URL: u, Size: int64(f.Clen)})
	}
	for _, c := range v.Captions {
		u, ok := onOrigin(c.URL)
		if !ok || !strings.HasPrefix(mustPath(u), "/api/v1/captions/") {
			continue
		}
		out.Captions = append(out.Captions, playback.VideoCaption{Label: c.Label, Language: c.LanguageCode, URL: u})
	}
	return out
}

func mustPath(u string) string {
	p, err := url.Parse(u)
	if err != nil {
		return ""
	}
	return p.Path
}

// audioTag reads YouTube's audio track tag from a stream URL's xtags
// ("acont=dubbed:lang=ja", "acont=original:drc=1:lang=en"). Videos with
// several audio tracks (YouTube's auto-dubs) list them all under itag 140.
// A track without a tag is the only, original one.
func audioTag(raw string) (lang string, original, drc bool) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", true, false
	}
	x := u.Query().Get("xtags")
	if x == "" {
		return "", true, false
	}
	original = true
	for _, kv := range strings.Split(x, ":") {
		k, v, _ := strings.Cut(kv, "=")
		switch k {
		case "lang":
			lang = strings.ToLower(v)
		case "acont":
			original = v == "original"
		case "drc":
			drc = v == "1"
		}
	}
	return lang, original, drc
}

// sortAudio orders AAC tracks for the player, which plays the first: the
// viewer's language (original or dub), then the original audio, then
// English, then the rest; the plain (not volume-levelled) copy and the
// higher bitrate first within each.
func sortAudio(ts []playback.VideoTrack, want string) {
	rank := func(t playback.VideoTrack) (int, int) {
		lang, original, drc := audioTag(t.URL)
		base, _, _ := strings.Cut(lang, "-")
		r := 3
		switch {
		case want != "" && base == want:
			r = 0
		case original:
			r = 1
		case base == "en":
			r = 2
		}
		d := 0
		if drc {
			d = 1
		}
		return r, d
	}
	slices.SortStableFunc(ts, func(a, b playback.VideoTrack) int {
		ra, da := rank(a)
		rb, db := rank(b)
		if ra != rb {
			return ra - rb
		}
		if da != db {
			return da - db
		}
		switch {
		case a.Bandwidth > b.Bandwidth:
			return -1
		case a.Bandwidth < b.Bandwidth:
			return 1
		}
		return 0
	})
}
