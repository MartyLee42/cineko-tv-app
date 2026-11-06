package playback

import (
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// TorrentFile is one file of a torrent (contract: TorrentFile). Index is
// TorrServer's file id.
type TorrentFile struct {
	Index     int    `json:"index"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"size_bytes"`
	IsVideo   bool   `json:"is_video"`
	Season    *int   `json:"season"`
	Episode   *int   `json:"episode"`
	// extra marks samples, trailers and bonus material (never auto-selected).
	extra bool
}

var videoMIME = map[string]string{
	".mkv": "video/x-matroska", ".mk3d": "video/x-matroska",
	".mp4": "video/mp4", ".m4v": "video/mp4",
	".webm": "video/webm",
	".avi":  "video/x-msvideo", ".divx": "video/x-msvideo",
	".mov": "video/quicktime",
	".wmv": "video/x-ms-wmv",
	".ts":  "video/mp2t", ".m2ts": "video/mp2t", ".mts": "video/mp2t",
	".mpg": "video/mpeg", ".mpeg": "video/mpeg", ".vob": "video/mpeg",
	".flv": "video/x-flv",
	".3gp": "video/3gpp",
	".ogv": "video/ogg",
}

// MimeType returns the video MIME type for a file path ("" if not a video).
func MimeType(p string) string { return videoMIME[strings.ToLower(path.Ext(p))] }

// IsVideo reports whether p has a playable video extension.
func IsVideo(p string) bool { return MimeType(p) != "" }

var (
	// Word-bounded markers of non-feature material in a file or folder name.
	extraWords = regexp.MustCompile(`(?i)(^|[^\p{L}\d])(sample|trailers?|teasers?|featurettes?|extras?|bonus(es)?|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes|interviews?|making[ ._-]of|promo|сэмпл|трейлеры?|тизеры?|бонусы?|доп(олнительные)?[ ._-]?материалы|допы|дополнения|интервью|фильм[ ._-]о[ ._-]фильме)([^\p{L}\d]|$)`)

	// Season+episode in one token.
	reSxE       = regexp.MustCompile(`(?i)(?:^|[^\p{L}\d])s(\d{1,2})[ ._-]?e(\d{1,3})(?:[^\d]|$)`)
	reNxN       = regexp.MustCompile(`(?i)(?:^|[^\p{L}\d])(\d{1,2})x(\d{2,3})(?:[^\d]|$)`)
	reSeasonEp  = regexp.MustCompile(`(?i)season[ ._-]*(\d{1,2})[ ._,-]*ep(?:isode)?[ ._-]*(\d{1,3})(?:[^\d]|$)`)
	reRuSeasEp1 = regexp.MustCompile(`(?i)(\d{1,2})[ ._-]*сезон[ ._,-]*(\d{1,3})[ ._-]*(?:серия|эпизод)`)
	reRuSeasEp2 = regexp.MustCompile(`(?i)сезон[ ._-]*(\d{1,2})[ ._,-]*(?:серия|эпизод)[ ._-]*(\d{1,3})(?:[^\d]|$)`)

	// Episode only.
	reEp       = regexp.MustCompile(`(?i)(?:^|[^\p{L}\d])e(?:p|pisode)?[ ._-]?(\d{1,3})(?:[^\d]|$)`)
	reRuEp1    = regexp.MustCompile(`(?i)(?:серия|эпизод)[ ._-]*(\d{1,3})(?:[^\d]|$)`)
	reRuEp2    = regexp.MustCompile(`(?i)(?:^|[^\d])(\d{1,3})[ ._-]*(?:серия|эпизод)`)
	reDashNum  = regexp.MustCompile(`(?:^|\s)-\s(\d{1,3})(?:v\d)?(?:\s|$)`)
	reBracket  = regexp.MustCompile(`\[(\d{2,3})\]`)
	reLeadNum  = regexp.MustCompile(`^(\d{1,3})(?:[ ._)\]-]|$)`)
	reWholeNum = regexp.MustCompile(`^(?:\p{L}+[ ._-]+)?(\d{1,3})$`)

	// Season only (folder or torrent name).
	reSeason   = regexp.MustCompile(`(?i)(?:^|[^\p{L}\d])(?:s|season|сезон)[ ._-]?(\d{1,2})(?:[^\d]|$)`)
	reRuSeason = regexp.MustCompile(`(?i)(?:^|[^\d])(\d{1,2})[ ._-]*(?:й[ ._-]*)?сезон`)
)

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

// parseSeasonEpisode extracts season/episode from a file name (no folders).
func parseSeasonEpisode(name string) (season, episode int, ok bool) {
	for _, re := range []*regexp.Regexp{reSxE, reSeasonEp, reRuSeasEp1, reRuSeasEp2, reNxN} {
		if m := re.FindStringSubmatch(name); m != nil {
			return atoi(m[1]), atoi(m[2]), true
		}
	}
	return 0, 0, false
}

// parseEpisode extracts an episode number when the name carries no season.
func parseEpisode(name string) (int, bool) {
	for _, re := range []*regexp.Regexp{reEp, reRuEp1, reRuEp2, reDashNum, reBracket, reLeadNum, reWholeNum} {
		if m := re.FindStringSubmatch(name); m != nil {
			if n := atoi(m[1]); n > 0 {
				return n, true
			}
		}
	}
	return 0, false
}

// parseSeason extracts a season number from a folder/torrent name.
func parseSeason(name string) (int, bool) {
	if s, _, ok := parseSeasonEpisode(name); ok {
		return s, true
	}
	for _, re := range []*regexp.Regexp{reSeason, reRuSeason} {
		if m := re.FindStringSubmatch(name); m != nil {
			return atoi(m[1]), true
		}
	}
	return 0, false
}

// classify turns TorrServer's file list into TorrentFiles with parsed
// season/episode numbers.
func classify(files []fileStat) []TorrentFile {
	out := make([]TorrentFile, 0, len(files))
	for _, f := range files {
		tf := TorrentFile{Index: f.ID, Path: f.Path, SizeBytes: f.Length, IsVideo: IsVideo(f.Path)}
		clean := strings.ReplaceAll(f.Path, "\\", "/")
		dir, file := path.Split(clean)
		stem := strings.TrimSuffix(file, path.Ext(file))
		tf.extra = extraWords.MatchString(stem) || extraWords.MatchString(dir)
		if tf.IsVideo {
			if s, e, ok := parseSeasonEpisode(stem); ok {
				tf.Season, tf.Episode = &s, &e
			} else if e, ok := parseEpisode(stem); ok {
				tf.Episode = &e
				// Nearest folder that names a season wins.
				parts := strings.Split(strings.Trim(dir, "/"), "/")
				for i := len(parts) - 1; i >= 0; i-- {
					if s, ok := parseSeason(parts[i]); ok {
						tf.Season = &s
						break
					}
				}
			}
		}
		out = append(out, tf)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Index < out[j].Index })
	return out
}

// fileStat is a TorrServer file entry (decoupled from the client package for tests).
type fileStat struct {
	ID     int    `json:"id"`
	Path   string `json:"path"`
	Length int64  `json:"length"`
}

// target describes what to pick from a torrent.
type target struct {
	Episode bool // false = movie
	Season  int
	Number  int
	// From the release: the seasons/episodes its title claims.
	ReleaseSeasons  []int
	ReleaseEpisodes []int
}

// selectFile picks the file to play, or returns false (no_matching_file).
func selectFile(files []TorrentFile, t target) (TorrentFile, bool) {
	var videos, main []TorrentFile
	for _, f := range files {
		if !f.IsVideo {
			continue
		}
		videos = append(videos, f)
		if !f.extra {
			main = append(main, f)
		}
	}
	if !t.Episode {
		if len(main) > 0 {
			return largest(main), true
		}
		if len(videos) > 0 {
			return largest(videos), true
		}
		return TorrentFile{}, false
	}

	var exact, noSeason []TorrentFile
	seasonsSeen := map[int]bool{}
	for _, f := range main {
		if f.Season != nil {
			seasonsSeen[*f.Season] = true
		}
		if f.Episode == nil || *f.Episode != t.Number {
			continue
		}
		switch {
		case f.Season != nil && *f.Season == t.Season:
			exact = append(exact, f)
		case f.Season == nil:
			noSeason = append(noSeason, f)
		}
	}
	if len(exact) > 0 {
		return largest(exact), true
	}
	// Files without a season are trusted when nothing in the torrent points
	// at another season.
	if len(noSeason) > 0 && singleSeason(seasonsSeen, t) {
		return largest(noSeason), true
	}
	// A single-episode release with one main video file.
	if len(main) == 1 && slicesEq(t.ReleaseEpisodes, []int{t.Number}) &&
		(len(t.ReleaseSeasons) == 0 || slicesEq(t.ReleaseSeasons, []int{t.Season})) {
		f := main[0]
		if f.Episode == nil || *f.Episode == t.Number {
			return f, true
		}
	}
	return TorrentFile{}, false
}

func singleSeason(seen map[int]bool, t target) bool {
	for s := range seen {
		if s != t.Season {
			return false
		}
	}
	for _, s := range t.ReleaseSeasons {
		if s != t.Season {
			return false
		}
	}
	return true
}

func largest(fs []TorrentFile) TorrentFile {
	best := fs[0]
	for _, f := range fs[1:] {
		if f.SizeBytes > best.SizeBytes {
			best = f
		}
	}
	return best
}

func slicesEq(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
