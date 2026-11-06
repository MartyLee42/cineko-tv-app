package devices

import (
	"math"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Per-device playback profiles («Это устройство»). Mirrors
// packages/media-types/src/playbackPrefs.ts (keep the merge identical):
//   - auto: what the device detected itself (codecs, screen, throughput…);
//   - manual: the user's overrides (nil = automatic);
//   - effective: manual wins over auto; what release ranking uses.
// Nothing here is device-specific: TVs, phones and laptop browsers share it.

// PlaybackAuto is contract PlaybackAuto.
type PlaybackAuto struct {
	ScreenWidth   *int       `json:"screen_width,omitempty"`
	ScreenHeight  *int       `json:"screen_height,omitempty"`
	Video         []string   `json:"video,omitempty"`
	Audio         []string   `json:"audio,omitempty"`
	Containers    []string   `json:"containers,omitempty"`
	HLS           *bool      `json:"hls,omitempty"`
	Compat        *bool      `json:"compat,omitempty"`
	ThroughputBps *float64   `json:"throughput_bps,omitempty"`
	Model         *string    `json:"model,omitempty"`
	Platform      *string    `json:"platform,omitempty"`
	DetectedAt    *time.Time `json:"detected_at,omitempty"`
}

// PlaybackManual is contract PlaybackManual (nil = automatic).
type PlaybackManual struct {
	Preset         *string  `json:"preset,omitempty"`
	MaxResolution  *string  `json:"max_resolution,omitempty"`
	MaxBitrateMbps *int     `json:"max_bitrate_mbps,omitempty"` // 0 = unlimited
	MaxSizeGB      *float64 `json:"max_size_gb,omitempty"`
	VideoCodec     *string  `json:"video_codec,omitempty"`
	HDR            *string  `json:"hdr,omitempty"`
	Audio          *string  `json:"audio,omitempty"`
	DefaultPlayer  *string  `json:"default_player,omitempty"`
	PreferSmaller  *bool    `json:"prefer_smaller,omitempty"`
}

// EffectivePrefs is contract PlaybackEffective. Nil limits = none; nil
// codec lists = unknown (don't judge).
type EffectivePrefs struct {
	MaxResolution *string  `json:"max_resolution"`
	MaxBitrateBps *float64 `json:"max_bitrate_bps"`
	MaxSizeGB     *float64 `json:"max_size_gb"`
	VideoCodec    *string  `json:"video_codec"`
	AvoidHDR      bool     `json:"avoid_hdr"`
	Audio         *string  `json:"audio"`
	PreferSmaller bool     `json:"prefer_smaller"`
	Video         []string `json:"video"`
	AudioCodecs   []string `json:"audio_codecs"`
	Compat        bool     `json:"compat"`
	DefaultPlayer *string  `json:"default_player"`
}

// Constraint is contract PlaybackConstraint (a summary chip).
type Constraint struct {
	Code   string   `json:"code"`
	Value  string   `json:"value,omitempty"`
	Mbps   *float64 `json:"mbps,omitempty"`
	GB     *float64 `json:"gb,omitempty"`
	Codecs []string `json:"codecs,omitempty"`
}

// PlaybackPrefs is contract PlaybackPrefs.
type PlaybackPrefs struct {
	Auto        PlaybackAuto   `json:"auto"`
	Manual      PlaybackManual `json:"manual"`
	Effective   EffectivePrefs `json:"effective"`
	Constraints []Constraint   `json:"constraints"`
	UpdatedAt   *time.Time     `json:"updated_at"`
}

// ThroughputHeadroom is the share of the measured throughput a release may use.
const ThroughputHeadroom = 0.9

// UnmeasuredTVBitrateMbps caps TV-class devices (TV boxes, smart-TV
// engines, MSX) until a session measures their link: the «normal» preset's
// limit (PRESETS in @martytv/media-types). Without it a TV's first play could
// pick a 25+ Mbit/s remux on a link that carries 15. Mirrors effectivePrefs().
const UnmeasuredTVBitrateMbps = 15

// TVPlatforms are the auto.platform values the unmeasured cap applies to.
var TVPlatforms = []string{"android-tv", "tizen", "webos", "msx"}

// UnmeasuredCap reports whether the effective bitrate limit is the
// unmeasured-TV default (no manual value, no measured throughput).
func UnmeasuredCap(a PlaybackAuto, m PlaybackManual) bool {
	if m.MaxBitrateMbps != nil || (a.ThroughputBps != nil && *a.ThroughputBps > 0) {
		return false
	}
	return a.Platform != nil && slices.Contains(TVPlatforms, *a.Platform)
}

// ResolutionForScreen maps physical screen pixels to the highest useful
// resolution ("" = unknown).
func ResolutionForScreen(w, h *int) string {
	if w == nil || h == nil || *w <= 0 || *h <= 0 {
		return ""
	}
	long, short := max(*w, *h), min(*w, *h)
	switch {
	case long >= 3200 || short >= 1800:
		return "2160p"
	case long >= 1800 || short >= 1000:
		return "1080p"
	}
	return "720p"
}

// Effective merges auto and manual (manual wins), like effectivePrefs() in TS.
func Effective(a PlaybackAuto, m PlaybackManual) EffectivePrefs {
	var e EffectivePrefs
	switch {
	case m.MaxBitrateMbps != nil && *m.MaxBitrateMbps == 0:
	case m.MaxBitrateMbps != nil && *m.MaxBitrateMbps > 0:
		v := float64(*m.MaxBitrateMbps) * 1e6
		e.MaxBitrateBps = &v
	case a.ThroughputBps != nil && *a.ThroughputBps > 0:
		v := math.Round(*a.ThroughputBps * ThroughputHeadroom)
		e.MaxBitrateBps = &v
	case UnmeasuredCap(a, m):
		v := float64(UnmeasuredTVBitrateMbps) * 1e6
		e.MaxBitrateBps = &v
	}
	if m.MaxResolution != nil {
		e.MaxResolution = m.MaxResolution
	} else if r := ResolutionForScreen(a.ScreenWidth, a.ScreenHeight); r != "" {
		e.MaxResolution = &r
	}
	if m.MaxSizeGB != nil && *m.MaxSizeGB > 0 {
		e.MaxSizeGB = m.MaxSizeGB
	}
	e.VideoCodec = m.VideoCodec
	e.AvoidHDR = m.HDR != nil && *m.HDR == "avoid" ||
		m.HDR == nil && a.Video != nil && !slices.Contains(a.Video, "hdr10") && !slices.Contains(a.Video, "dv")
	e.Audio = m.Audio
	e.PreferSmaller = m.PreferSmaller != nil && *m.PreferSmaller
	if len(a.Video) > 0 {
		e.Video = a.Video
	}
	if len(a.Audio) > 0 {
		e.AudioCodecs = a.Audio
	}
	e.Compat = a.Compat != nil && *a.Compat
	e.DefaultPlayer = m.DefaultPlayer
	return e
}

var heavyAudio = []string{"ac3", "eac3", "dts", "truehd"}

// Constraints summarizes the effective prefs, like constraints() in TS.
func Constraints(e EffectivePrefs) []Constraint {
	out := []Constraint{}
	if e.MaxResolution != nil && *e.MaxResolution != "2160p" {
		out = append(out, Constraint{Code: "max_resolution", Value: *e.MaxResolution})
	}
	if e.MaxBitrateBps != nil && *e.MaxBitrateBps > 0 {
		v := math.Round(*e.MaxBitrateBps / 1e6)
		out = append(out, Constraint{Code: "max_bitrate", Mbps: &v})
	}
	if e.MaxSizeGB != nil {
		out = append(out, Constraint{Code: "max_size", GB: e.MaxSizeGB})
	}
	if e.VideoCodec != nil {
		out = append(out, Constraint{Code: "codec", Value: *e.VideoCodec})
	}
	if e.AvoidHDR {
		out = append(out, Constraint{Code: "no_hdr"})
	}
	audio := ""
	if e.Audio != nil {
		audio = *e.Audio
	}
	if audio == "always_compat" {
		out = append(out, Constraint{Code: "compat_audio"})
	} else {
		var missing []string
		switch {
		case audio == "avoid_dts_truehd":
			missing = []string{"dts", "truehd"}
		case audio == "prefer_aac_ac3":
			missing = []string{"eac3", "dts", "truehd"}
		case e.AudioCodecs != nil:
			for _, c := range heavyAudio {
				if !slices.Contains(e.AudioCodecs, c) {
					missing = append(missing, c)
				}
			}
		}
		if len(missing) > 0 {
			out = append(out, Constraint{Code: "no_audio", Codecs: missing})
		}
	}
	if e.PreferSmaller {
		out = append(out, Constraint{Code: "smaller"})
	}
	return out
}

// NewPlaybackPrefs builds the response shape.
func NewPlaybackPrefs(a PlaybackAuto, m PlaybackManual, updatedAt *time.Time) PlaybackPrefs {
	e := Effective(a, m)
	return PlaybackPrefs{Auto: a, Manual: m, Effective: e, Constraints: Constraints(e), UpdatedAt: updatedAt}
}

// ---------------------------------------------------------------- validation

var (
	videoTokens     = []string{"h264", "hevc", "vp9", "av1", "hdr10", "dv"}
	audioTokens     = []string{"aac", "ac3", "eac3", "dts", "truehd", "mp3", "opus", "flac"}
	containerTokens = []string{"mkv", "mp4", "ts"}
	presetRe        = regexp.MustCompile(`^[a-z0-9_]{0,32}$`)
)

// MaxPrefsBody bounds a playback-prefs PATCH body.
const MaxPrefsBody = 8 << 10

func checkTokens(fields map[string]string, name string, list []string, known []string) []string {
	if len(list) > 16 {
		fields[name] = "at most 16 items"
		return nil
	}
	out := []string{}
	for _, v := range list {
		v = strings.ToLower(strings.TrimSpace(v))
		if !slices.Contains(known, v) {
			fields[name] = "must be a subset of: " + strings.Join(known, ", ")
			return nil
		}
		if !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}

func checkEnum(fields map[string]string, name string, v *string, known ...string) {
	if v != nil && !slices.Contains(known, *v) {
		fields[name] = "must be one of: " + strings.Join(known, ", ")
	}
}

func checkRange(fields map[string]string, name string, v *float64, lo, hi float64) {
	if v != nil && (math.IsNaN(*v) || *v < lo || *v > hi) {
		fields[name] = "out of range"
	}
}

func intRange(fields map[string]string, name string, v *int, lo, hi int) {
	if v != nil && (*v < lo || *v > hi) {
		fields[name] = "out of range"
	}
}

func clipStr(v *string, n int) *string {
	if v == nil {
		return nil
	}
	s := strings.TrimSpace(*v)
	if r := []rune(s); len(r) > n {
		s = string(r[:n])
	}
	return &s
}

// Normalize validates auto in place (field errors keyed "auto.<field>").
func (a *PlaybackAuto) Normalize(fields map[string]string) {
	intRange(fields, "auto.screen_width", a.ScreenWidth, 0, 16384)
	intRange(fields, "auto.screen_height", a.ScreenHeight, 0, 16384)
	if a.Video != nil {
		a.Video = checkTokens(fields, "auto.video", a.Video, videoTokens)
	}
	if a.Audio != nil {
		a.Audio = checkTokens(fields, "auto.audio", a.Audio, audioTokens)
	}
	if a.Containers != nil {
		a.Containers = checkTokens(fields, "auto.containers", a.Containers, containerTokens)
	}
	checkRange(fields, "auto.throughput_bps", a.ThroughputBps, 0, 10e9)
	a.Model = clipStr(a.Model, 128)
	a.Platform = clipStr(a.Platform, 64)
}

// Normalize validates manual (field errors keyed "manual.<field>").
func (m *PlaybackManual) Normalize(fields map[string]string) {
	if m.Preset != nil && !presetRe.MatchString(*m.Preset) {
		fields["manual.preset"] = "must be a short preset id"
	}
	checkEnum(fields, "manual.max_resolution", m.MaxResolution, "720p", "1080p", "2160p")
	intRange(fields, "manual.max_bitrate_mbps", m.MaxBitrateMbps, 0, 1000)
	checkRange(fields, "manual.max_size_gb", m.MaxSizeGB, 0, 500)
	checkEnum(fields, "manual.video_codec", m.VideoCodec, "h264", "hevc")
	checkEnum(fields, "manual.hdr", m.HDR, "allow", "avoid")
	checkEnum(fields, "manual.audio", m.Audio, "prefer_aac_ac3", "avoid_dts_truehd", "always_compat")
	checkEnum(fields, "manual.default_player", m.DefaultPlayer, "builtin", "msx", "external")
}
