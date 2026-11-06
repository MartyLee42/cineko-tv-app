package video

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
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
	// Best AAC first (itag 140 = 128 kbit/s is the usual one).
	for i := 1; i < len(out.Audio); i++ {
		for j := i; j > 0 && out.Audio[j].Bandwidth > out.Audio[j-1].Bandwidth; j-- {
			out.Audio[j], out.Audio[j-1] = out.Audio[j-1], out.Audio[j]
		}
	}
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
