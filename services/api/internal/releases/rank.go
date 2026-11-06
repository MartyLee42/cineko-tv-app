package releases

import (
	"math"
	"slices"
	"sort"
	"strings"

	"martytv/api/internal/devices"
)

// Prefs are the ranking preferences (from a profile, or defaults).
type Prefs struct {
	Languages  []string // preferred audio languages, most preferred first
	Resolution string   // "", 480p, 720p, 1080p, 2160p ("" ranks as 1080p)
	MaxSizeGB  *float64
	Codecs     []string // preferred video/audio codecs (hevc, h264, av1, aac, ac3…)
	// Voiceovers are preferred dub/voice-over studios, most preferred first
	// ("LostFilm", "HDRezka Studio"…); matched case-insensitively.
	Voiceovers []string
	// Device is the effective playback profile of the TV/browser the list
	// is for (nil = none): penalties and warnings, never hiding.
	Device *devices.EffectivePrefs
	// RuntimeSeconds is the movie/episode runtime (0 = unknown) for the
	// estimated bitrate.
	RuntimeSeconds int
}

// voiceoverIndex returns the best (lowest) preference index among the
// release's studios, or -1.
func voiceoverIndex(vs []Voiceover, prefs []string) int {
	best := -1
	for _, v := range vs {
		if v.Studio == nil {
			continue
		}
		for i, p := range prefs {
			if strings.EqualFold(strings.TrimSpace(p), *v.Studio) && (best < 0 || i < best) {
				best = i
			}
		}
	}
	return best
}

// candidate is an accepted release plus the parse details ranking needs.
// It is what the list cache stores (server-side only).
type candidate struct {
	Release      Release `json:"release"`
	TenBit       bool    `json:"ten_bit,omitempty"`
	DolbyVision  bool    `json:"dv,omitempty"`
	HDR10        bool    `json:"hdr10,omitempty"`
	DiscImage    bool    `json:"disc,omitempty"`
	CamAudio     bool    `json:"cam_audio,omitempty"`
	ThreeD       bool    `json:"three_d,omitempty"`
	Upscale      bool    `json:"upscale,omitempty"`
	EpisodeCount int     `json:"episode_count,omitempty"` // files in a pack, for the size limit
	Uncertain    bool    `json:"uncertain,omitempty"`     // accepted only via «Уточнить» (loose matching)
}

var resRank = map[string]int{"2160p": 4, "1080p": 3, "720p": 2, "576p": 1, "480p": 1}

func resolutionFactor(res, pref string) float64 {
	if pref == "" {
		pref = "1080p"
	}
	r, ok := resRank[res]
	if !ok {
		return 0.7
	}
	d := r - resRank[pref]
	switch {
	case d == 0:
		return 1
	case d < 0:
		return max(0.3, 1+0.2*float64(d))
	default:
		return 1 - 0.08*float64(d)
	}
}

var sourceFactor = map[string]float64{
	"remux": 1, "bdrip": 0.95, "web-dl": 0.95, "webrip": 0.85, "hdtv": 0.75, "dvd": 0.6,
	"bluray": 0.35, "screener": 0.4, "telesync": 0.15, "cam": 0.1, "": 0.8,
}

// availability is log-scaled: 1 seeder 0.5, 10 ≈ 0.77, 50+ = 1; 0 ⇒ bottom.
func availability(seeders int) float64 {
	if seeders <= 0 {
		return 0.02
	}
	return 0.4 + 0.6*min(1, math.Log1p(float64(seeders))/math.Log1p(50))
}

func round4(f float64) float64 { return math.Round(f*10000) / 10000 }

// Rank scores and orders accepted candidates for a viewer. The order is
// deterministic: score, confidence, seeders, size, id.
func Rank(cands []candidate, prefs Prefs) []Release {
	out := make([]Release, 0, len(cands))
	for _, c := range cands {
		r := c.Release
		r.Warnings = []string{}
		warn := func(w string) {
			if !slices.Contains(r.Warnings, w) {
				r.Warnings = append(r.Warnings, w)
			}
		}

		if c.Uncertain {
			warn("uncertain_match")
		}

		r.EstBitrateBps = estBitrate(c, prefs.RuntimeSeconds)

		// Quality: resolution vs preference (clipped to the device) × source.
		q := resolutionFactor(deref(r.Resolution), clipResolution(prefs.Resolution, prefs.Device))
		q *= sourceFactor[deref(r.SourceQuality)]
		switch deref(r.SourceQuality) {
		case "cam", "telesync", "screener":
			warn("cam_quality")
		case "bluray", "dvd":
			if c.DiscImage {
				warn("disc_image") // BDMV/VIDEO_TS: not streamable as one file
			}
		}
		if c.CamAudio {
			q *= 0.4
			warn("cam_quality")
		}
		if c.ThreeD {
			q *= 0.5
			warn("3d")
		}
		if c.Upscale {
			q *= 0.9
		}

		// Availability.
		a := availability(r.Seeders)
		if r.Seeders < 3 {
			warn("low_seeders")
		}

		// Preference fit.
		p := 1.0
		if len(r.Languages) == 0 {
			p *= 0.85
		} else if idx := langIndex(r.Languages, prefs.Languages); idx < 0 {
			p *= 0.5
			warn("no_preferred_language")
		} else {
			p *= 1 - 0.1*float64(min(idx, 3))
		}
		if r.Voiceovers == nil {
			r.Voiceovers = []Voiceover{} // older cached results
		}
		if idx := voiceoverIndex(r.Voiceovers, prefs.Voiceovers); idx >= 0 {
			// A preferred studio outweighs small quality differences.
			p *= 1.3 - 0.05*float64(min(idx, 4))
			r.Reasons = append(slices.Clip(r.Reasons), "preferred_voiceover") // don't write into the cached slice
		}
		if limit := sizeLimit(prefs); limit > 0 {
			if perItemBytes(c) > limit*(1<<30) {
				p *= 0.3
				warn("over_size_limit")
			}
		}
		codecs := r.AudioCodecs
		if r.VideoCodec != nil {
			codecs = append([]string{*r.VideoCodec}, codecs...)
		}
		if len(prefs.Codecs) > 0 {
			switch {
			case slices.ContainsFunc(codecs, func(c string) bool { return containsFold(prefs.Codecs, c) }):
			case r.VideoCodec != nil:
				p *= 0.85
			default:
				p *= 0.95
			}
		}
		if prefs.Device != nil {
			p *= deviceFit(c, &r, *prefs.Device, warn)
		}
		if !deviceJudgesCodecs(prefs.Device) && unplayable(c, r) && !slices.ContainsFunc(codecs, func(c string) bool { return containsFold(prefs.Codecs, c) }) {
			p *= 0.75
			warn("likely_unplayable_codec")
		}

		r.Score = round4(r.Confidence * q * a * p)
		out = append(out, r)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		switch {
		case a.Score != b.Score:
			return a.Score > b.Score
		case a.Confidence != b.Confidence:
			return a.Confidence > b.Confidence
		case a.Seeders != b.Seeders:
			return a.Seeders > b.Seeders
		case a.SizeBytes != b.SizeBytes:
			return a.SizeBytes > b.SizeBytes
		}
		return a.ID < b.ID
	})
	return out
}

// unplayable flags streams TV browsers commonly can't decode: HEVC 10-bit,
// AV1, Dolby Vision without an HDR10 base layer, and audio that is only
// DTS/TrueHD.
func unplayable(c candidate, r Release) bool {
	vc := deref(r.VideoCodec)
	if vc == "hevc" && c.TenBit || vc == "av1" || c.DolbyVision && !c.HDR10 {
		return true
	}
	if len(r.AudioCodecs) > 0 && !slices.ContainsFunc(r.AudioCodecs, func(a string) bool { return a != "dts" && a != "truehd" }) {
		return true
	}
	return false
}

func langIndex(have, prefs []string) int {
	best := -1
	for _, l := range have {
		for i, p := range prefs {
			if strings.EqualFold(l, p) && (best < 0 || i < best) {
				best = i
			}
		}
	}
	return best
}

func containsFold(list []string, s string) bool {
	return slices.ContainsFunc(list, func(x string) bool { return strings.EqualFold(x, s) })
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
