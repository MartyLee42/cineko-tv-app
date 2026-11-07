package releases

import (
	"math"
	"regexp"
	"slices"

	"martytv/api/internal/devices"
)

// Device playback profiles (docs/architecture.md «Device playback profiles»):
// the effective prefs of the TV/browser a list is for re-rank releases per
// request with multiplicative penalties; nothing is hidden. Each factor is
// monotone in how badly a release misses the constraint.

// DeviceFit is ReleaseList.device: whose playback profile ranked the list.
type DeviceFit struct {
	Kind        string                 `json:"kind"` // device | client
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Constraints []devices.Constraint   `json:"constraints"`
	Prefs       devices.EffectivePrefs `json:"-"`
}

// HasDeviceLimits reports whether effective prefs can judge anything (a
// device that never reported and has no overrides ranks like no device).
func HasDeviceLimits(e devices.EffectivePrefs) bool {
	return e.MaxResolution != nil || e.MaxBitrateBps != nil || e.MaxSizeGB != nil || e.VideoCodec != nil ||
		e.AvoidHDR || e.Audio != nil || e.PreferSmaller || e.Video != nil || e.AudioCodecs != nil || e.Rough != nil
}

// perItemBytes is the size of one movie/episode (packs: size / episodes).
func perItemBytes(c candidate) float64 {
	per := float64(c.Release.SizeBytes)
	if c.EpisodeCount > 1 {
		per /= float64(c.EpisodeCount)
	}
	return per
}

// estBitrate is size × 8 / runtime per movie/episode, bits/s (nil = unknown).
func estBitrate(c candidate, runtime int) *float64 {
	if runtime <= 0 || c.Release.SizeBytes <= 0 {
		return nil
	}
	v := math.Round(perItemBytes(c) * 8 / float64(runtime))
	return &v
}

// clipResolution caps the profile's preferred resolution at the device max.
func clipResolution(pref string, d *devices.EffectivePrefs) string {
	if d == nil || d.MaxResolution == nil {
		return pref
	}
	eff := pref
	if eff == "" {
		eff = "1080p"
	}
	if resRank[eff] > resRank[*d.MaxResolution] {
		return *d.MaxResolution
	}
	return pref
}

// sizeLimit is the stricter of the profile's and the device's size limits (GB, 0 = none).
func sizeLimit(p Prefs) float64 {
	limit := 0.0
	if p.MaxSizeGB != nil && *p.MaxSizeGB > 0 {
		limit = *p.MaxSizeGB
	}
	if p.Device != nil && p.Device.MaxSizeGB != nil && *p.Device.MaxSizeGB > 0 && (limit == 0 || *p.Device.MaxSizeGB < limit) {
		limit = *p.Device.MaxSizeGB
	}
	return limit
}

// deviceJudgesCodecs: the device's decodable lists replace the generic
// «likely unplayable» heuristic.
func deviceJudgesCodecs(d *devices.EffectivePrefs) bool {
	return d != nil && (d.Video != nil || d.AudioCodecs != nil)
}

// videoNeeds is the decoder token a release needs ("" = don't judge).
func videoNeeds(c candidate, r *Release) string {
	if c.DolbyVision && !c.HDR10 {
		return "dv" // Dolby Vision without an HDR10 base layer
	}
	switch deref(r.VideoCodec) {
	case "h264", "hevc", "av1":
		return *r.VideoCodec
	case "xvid":
		return "mpeg4" // XviD / DivX = MPEG-4 Part 2
	case "mpeg2":
		return "mpeg2"
	}
	if r.VideoCodec == nil && aviTitle.MatchString(r.Title) {
		return "mpeg4" // "….avi" / "[AVI]": in practice XviD / DivX
	}
	return ""
}

var aviTitle = regexp.MustCompile(`(?i)(?:\.avi\b|\bAVI\b)`)

// likelyXvid: an old-style rip that names neither codec nor resolution
// («The Last Duel (2021) BDRip», 2 GB) — on the trackers that is nearly
// always an XviD AVI; modern H.264 rips say AVC / x264 / 720p / 1080p.
func likelyXvid(r *Release) bool {
	if r.VideoCodec != nil || r.Resolution != nil {
		return false
	}
	switch deref(r.SourceQuality) {
	case "bdrip", "webrip", "hdtv", "dvd":
		return true
	}
	return false
}

func isHDR(c candidate, r *Release) bool {
	return r.HDR != nil || c.HDR10 || c.DolbyVision
}

var tenBitTitle = regexp.MustCompile(`(?i)(?:^|[^0-9])10[- ]?bit|\bHi10P?\b`)

// smoothToken is the auto.rough token of a release ("hevc_10bit_2160p"; ""
// = not judged). Mirrors releaseSmoothToken in @martytv/media-types smooth.ts.
func smoothToken(c candidate, r *Release) string {
	codec := deref(r.VideoCodec)
	if codec != "h264" && codec != "hevc" && codec != "av1" {
		return ""
	}
	res := deref(r.Resolution)
	if res != "1080p" && res != "2160p" {
		return ""
	}
	ten := isHDR(c, r) || c.TenBit || tenBitTitle.MatchString(r.Title)
	if ten && codec == "h264" {
		return "" // 10-bit H.264 is a decodability question, not smoothness
	}
	if ten {
		return codec + "_10bit_" + res
	}
	return codec + "_" + res
}

// deviceFit is the device-profile factor of one release; it adds warnings
// and the device_fit reason when nothing was penalized.
func deviceFit(c candidate, r *Release, d devices.EffectivePrefs, warn func(string)) float64 {
	f := 1.0
	fits := true
	miss := func(factor float64, w string) {
		f *= factor
		fits = false
		warn(w)
	}

	// Resolution above the device max: ×0.4 per step.
	if d.MaxResolution != nil {
		if rr, ok := resRank[deref(r.Resolution)]; ok {
			if steps := rr - resRank[*d.MaxResolution]; steps > 0 {
				miss(math.Pow(0.4, float64(steps)), "over_device_resolution")
			}
		}
	}

	// Bitrate vs the device cap (manual Mbit/s or measured throughput × 0.9).
	if d.MaxBitrateBps != nil && *d.MaxBitrateBps > 0 && r.EstBitrateBps != nil {
		if ratio := *r.EstBitrateBps / *d.MaxBitrateBps; ratio > 1.3 {
			miss(max(0.08, 0.5/ratio), "too_heavy_for_device")
		} else if ratio > 1 {
			miss(0.75, "too_heavy_for_device")
		}
	}

	// Size limit (the stricter one is applied by Rank as over_size_limit).
	if d.MaxSizeGB != nil && *d.MaxSizeGB > 0 && perItemBytes(c) > *d.MaxSizeGB*(1<<30) {
		fits = false
	}

	// Video the device can't decode.
	if need := videoNeeds(c, r); need != "" && d.Video != nil && !slices.Contains(d.Video, need) {
		miss(0.3, "codec_unsupported")
	} else if need == "" && d.Video != nil && !slices.Contains(d.Video, "mpeg4") && likelyXvid(r) {
		miss(0.5, "codec_unknown")
	}
	if d.AvoidHDR && isHDR(c, r) {
		miss(0.6, "hdr_avoided")
	}
	// Decodes, but not smoothly here (decodingInfo / dropped frames).
	if t := smoothToken(c, r); t != "" && slices.Contains(d.Rough, t) {
		miss(0.6, "may_stutter")
	}
	if d.VideoCodec != nil && deref(r.VideoCodec) == *d.VideoCodec {
		f *= 1.1
	}

	// Audio.
	audioPref := ""
	if d.Audio != nil {
		audioPref = *d.Audio
	}
	if len(r.AudioCodecs) > 0 && (d.AudioCodecs != nil || audioPref == "avoid_dts_truehd") {
		decodable := func(a string) bool {
			if audioPref == "avoid_dts_truehd" && (a == "dts" || a == "truehd") {
				return false
			}
			return d.AudioCodecs == nil || slices.Contains(d.AudioCodecs, a)
		}
		switch {
		case slices.ContainsFunc(r.AudioCodecs, decodable):
			f *= 1.05
		case audioPref == "always_compat" && d.Compat:
			// The user always plays through the compat (AAC) stream.
		case d.Compat:
			miss(0.85, "audio_needs_conversion")
		default:
			miss(0.4, "audio_unsupported")
		}
	}
	if audioPref == "prefer_aac_ac3" && (slices.Contains(r.AudioCodecs, "aac") || slices.Contains(r.AudioCodecs, "ac3")) {
		f *= 1.05
	}

	// Gentle bias towards lighter files.
	if d.PreferSmaller {
		if r.EstBitrateBps != nil {
			f *= math.Sqrt(1 / (1 + *r.EstBitrateBps/1e6/25))
		} else {
			f *= math.Sqrt(1 / (1 + perItemBytes(c)/(1<<30)/10))
		}
	}

	if fits && HasDeviceLimits(d) {
		r.Reasons = append(slices.Clip(r.Reasons), "device_fit") // don't write into the cached slice
	}
	return f
}
