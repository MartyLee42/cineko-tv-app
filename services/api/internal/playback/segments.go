package playback

import (
	"context"
	"time"

	"martytv/api/internal/segments"
)

// Skip markers (intro / recap / credits) for torrent and online sources:
// the file's chapters, the provider's markers, then TheIntroDB / IntroDB
// (internal/segments). Players offer «Пропустить заставку» and «Следующая
// серия» and may skip them automatically.

// segmentsWait: how long a live GET waits for an uncached lookup (Create
// prefetches it, so this is usually a cache hit).
const segmentsWait = 1500 * time.Millisecond

// openEnding: an ending of unknown length (the file's duration isn't probed
// yet) runs this long; players clamp it to the media's duration.
const openEnding = 15 * 60

// SetSegments enables the intro/credits databases.
func (s *Service) SetSegments(seg *segments.Service) { s.segs = seg }

func (s *Service) prefetchSegments(mediaID string, episodeID *string) {
	if s.segs != nil {
		s.segs.Prefetch(mediaID, episodeID, nil, nil)
	}
}

// markersFor merges the segments for a source. length is the media's
// duration in seconds (0 = unknown); season/episode are the file's numbers
// when the source has no episode id (a season pack).
func (s *Service) markersFor(ctx context.Context, src *source, season, episode *int, provider []segments.Segment, length float64) []SkipMarker {
	var chapters []segments.Segment
	if src.MediaInfo != nil {
		chapters = segments.FromChapters(chaptersOf(src.MediaInfo))
	}
	var db []segments.Segment
	if s.segs != nil {
		lctx, cancel := context.WithTimeout(ctx, segmentsWait)
		db = s.segs.ForMedia(lctx, src.MediaID, src.EpisodeID, season, episode)
		cancel()
	}
	return toMarkers(segments.Fit(segments.Merge(chapters, provider, db), length))
}

func toMarkers(segs []segments.Segment) []SkipMarker {
	var out []SkipMarker
	for _, sg := range segs {
		end := sg.End
		if end == 0 {
			if sg.Kind != segments.Ending {
				continue
			}
			end = sg.Start + openEnding
		}
		out = append(out, SkipMarker{Kind: sg.Kind, StartSeconds: round3(sg.Start), EndSeconds: round3(end), Source: sg.Source})
	}
	return out
}

func round3(f float64) float64 { return float64(int64(f*1000+0.5)) / 1000 }

func chaptersOf(mi *MediaInfo) []segments.Chapter {
	out := make([]segments.Chapter, 0, len(mi.Chapters))
	for _, c := range mi.Chapters {
		out = append(out, segments.Chapter{Start: c.StartSeconds, End: c.EndSeconds, Title: c.Title})
	}
	return out
}

func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
