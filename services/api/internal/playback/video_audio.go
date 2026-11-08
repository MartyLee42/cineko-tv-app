package playback

import (
	"regexp"
	"strings"
)

// YouTube audio tracks. Auto-dubbed videos list one AAC itag 140 per
// language (VideoTrack.Lang, from the stream URL's xtags; the provider
// orders them: VIDEO_LANG, the original, English…). A source plays one of
// them: the request's `audio` (a language, or "original") when the video
// has it, else the first. The language rides in the stream's file names
// (master.ru.m3u8 → a140.ru.m3u8 → m140.ru.mp4), so tokens don't change and
// a switch is a new source (the players continue from the same position).

// VideoAudioTrack is one choice of PlaybackSource.audio_tracks.
type VideoAudioTrack struct {
	ID       string `json:"id"`       // the language ("ru", "pt-br"); "" = the only, untagged track
	Language string `json:"language"` // same as ID
	Original bool   `json:"original"` // the video's own audio (not a dub)
}

// AudioOriginal asks for the video's own audio track.
const AudioOriginal = "original"

var audioLangRe = regexp.MustCompile(`^[a-z]{2,3}(-[a-z0-9]{2,8})?$`)

// validAudioPref: "", "original" or a language tag.
func validAudioPref(p string) bool {
	return p == "" || p == AudioOriginal || audioLangRe.MatchString(strings.ToLower(p))
}

// audioChoices is one track per language, in the provider's order (the
// first of each: the plain copy before the volume-levelled one).
func audioChoices(ts []VideoTrack) []VideoTrack {
	seen := map[string]bool{}
	var out []VideoTrack
	for _, t := range ts {
		if seen[t.Lang] {
			continue
		}
		seen[t.Lang] = true
		out = append(out, t)
	}
	return out
}

// pickAudio is the track a source plays for the viewer's preference: the
// original, a language (exact, else the same base language: "pt" → "pt-br"),
// else the provider's first. nil when there is no audio.
func pickAudio(ts []VideoTrack, pref string) *VideoTrack {
	if len(ts) == 0 {
		return nil
	}
	pref = strings.ToLower(pref)
	if pref == AudioOriginal {
		for i := range ts {
			if ts[i].Original {
				return &ts[i]
			}
		}
	} else if pref != "" {
		base, _, _ := strings.Cut(pref, "-")
		var near *VideoTrack
		for i := range ts {
			if ts[i].Lang == pref {
				return &ts[i]
			}
			if b, _, _ := strings.Cut(ts[i].Lang, "-"); near == nil && b == base {
				near = &ts[i]
			}
		}
		if near != nil {
			return near
		}
	}
	return &ts[0]
}

// findAudio is the audio track of a file name (itag + language).
func findAudio(ts []VideoTrack, itag int, lang string) *VideoTrack {
	for i := range ts {
		if ts[i].Itag == itag && ts[i].Lang == lang {
			return &ts[i]
		}
	}
	return nil
}

// audioSuffix is the file-name part of a track's language ("" or ".ru").
func audioSuffix(t *VideoTrack) string {
	if t == nil || t.Lang == "" {
		return ""
	}
	return "." + t.Lang
}

// audioTrackList is PlaybackSource.audio_tracks (empty for one track).
func audioTrackList(ts []VideoTrack) []VideoAudioTrack {
	cs := audioChoices(ts)
	if len(cs) < 2 {
		return []VideoAudioTrack{}
	}
	out := make([]VideoAudioTrack, 0, len(cs))
	for _, t := range cs {
		out = append(out, VideoAudioTrack{ID: t.Lang, Language: t.Lang, Original: t.Original})
	}
	return out
}
