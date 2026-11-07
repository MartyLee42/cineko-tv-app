package main

import (
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// Command lines. By default the video is copied (-c:v copy): the only CPU
// cost is decoding one audio track and encoding it to AAC. A job with
// Video "h264" re-encodes the video with libx264 or a GPU (hwaccel.go):
// XviD / DivX / MPEG-2 / VC-1 that the TV can't decode; the API allows it
// for ≤ 1080p sources.

// seekPad: ffmpeg seeks to (-ss − 3/23 s) when the video has B-frames (a
// "dts heuristic" in fftools), which from exactly a keyframe's time lands on
// the previous keyframe. -ss K+seekPad seeks to keyframe K; the copied video
// then starts seekPad before the output's zero and the MP4 muxer shifts the
// whole output so that t=0 is K. Subtitles (no video in that output) get the
// same shift with -output_ts_offset.
const seekPad = 0.15

// inputArgs opens the TorrServer stream. ffmpeg seeks with HTTP Range
// (TorrServer supports it); -ss before -i is an input seek to a keyframe, so
// the output starts there at t=0. start must be a keyframe time (Server
// resolves it with KeyframeArgs first).
// pre holds extra input options (placed right before -i).
func inputArgs(j *Job, start float64, pre ...string) []string {
	a := []string{"-hide_banner", "-nostdin", "-nostats", "-loglevel", "error"}
	if j.Auth != "" {
		a = append(a, "-headers", "Authorization: "+j.Auth+"\r\n")
	}
	// TorrServer may stall while pieces download; reconnect on drops, give up
	// after 2 min without data (the watchdog would anyway).
	a = append(a, "-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "10", "-rw_timeout", "120000000")
	if start > 0 {
		// Re-encoded video: ffmpeg decodes from the keyframe before -ss and
		// drops frames up to it (accurate seek), so start (the keyframe
		// itself) is exactly t=0 — no pad needed.
		if j.Video == VideoH264 {
			a = append(a, "-ss", fmtSeconds(start))
		} else {
			a = append(a, "-ss", fmtSeconds(start+seekPad))
		}
	}
	if j.Video == VideoH264 {
		// AVI (XviD packed B-frames) often lacks pts; the encoder needs them.
		// Decoders get the same thread cap as the encoder.
		a = append(a, "-fflags", "+genpts", "-threads", strconv.Itoa(videoThreads(j)))
		a = append(a, hwInputArgs(j.enc)...) // GPU device (none for libx264)
	}
	a = append(a, pre...)
	return append(a, "-i", j.Input)
}

// RemuxArgs: first video stream copied, one audio track → AAC (or copied when
// it already is AAC), fragmented MP4 to stdout.
func RemuxArgs(j *Job, start float64) []string {
	a := append(inputArgs(j, start), avArgs(j)...)
	return append(a,
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-f", "mp4", "pipe:1",
	)
}

// HLS output names, relative to the session directory (the process's cwd).
const (
	hlsPlaylist = "index.m3u8"
	hlsInit     = "init.mp4"
	hlsSegment  = "seg%d.m4s"
	// hlsSegmentTime: ffmpeg cuts at the first keyframe after this many
	// seconds (copied video: segments follow the file's GOPs; re-encoded
	// video has a keyframe every x264GOP seconds).
	hlsSegmentTime = 4
)

// Re-encoded video (Job.Video "h264"): libx264 tuned for "faster than real
// time on a few shared cores" — SD XviD is the main case. A keyframe every
// x264GOP seconds keeps fMP4 fragments / HLS segments short (first bytes
// sooner, seeks land close). Odd sizes are rounded down to even (4:2:0),
// interlaced frames (MPEG-2 from DVD/TV) are deinterlaced, progressive ones
// pass through untouched.
const (
	x264Preset = "veryfast"
	x264CRF    = "21"
	x264GOP    = 2
	// DefaultVideoThreads: libx264 threads per stream when not configured
	// (TRANSCODER_VIDEO_THREADS), so one stream can't take the whole box.
	DefaultVideoThreads = 2
)

func videoArgs(j *Job) []string {
	if j.Video != VideoH264 {
		a := []string{"-c:v", "copy"}
		if j.HVC1 {
			a = append(a, "-tag:v", "hvc1")
		}
		return a
	}
	return encodeArgs(j.enc, videoThreads(j))
}

// HLSArgs: the same streams as RemuxArgs, written as an fMP4 HLS EVENT
// playlist (index.m3u8 + init.mp4 + seg<N>.m4s) into the working directory.
// temp_file: segments and the playlist are written under a temporary name and
// renamed, so a listed segment is always complete.
func HLSArgs(j *Job, start float64) []string {
	a := append(inputArgs(j, start), avArgs(j)...)
	return append(a,
		"-f", "hls",
		"-hls_time", strconv.Itoa(hlsSegmentTime),
		"-hls_playlist_type", "event",
		"-hls_list_size", "0",
		"-hls_segment_type", "fmp4",
		"-hls_fmp4_init_filename", hlsInit,
		"-hls_segment_filename", hlsSegment,
		"-hls_flags", "independent_segments+temp_file",
		"-start_number", "0",
		hlsPlaylist,
	)
}

// videoThreads: the configured thread cap of a re-encoding job.
func videoThreads(j *Job) int {
	if j.threads > 0 {
		return j.threads
	}
	return DefaultVideoThreads
}

// avArgs: stream selection and codecs shared by the MP4 and HLS outputs.
func avArgs(j *Job) []string {
	// 0:V = video that isn't an attached picture (MP4 cover art).
	a := []string{"-map", "0:V:0"}
	if j.Audio != nil {
		a = append(a, "-map", "0:"+strconv.Itoa(*j.Audio))
	} else {
		a = append(a, "-map", "0:a:0?")
	}
	a = append(a, videoArgs(j)...)
	if j.AudioCopy {
		a = append(a, "-c:a", "copy")
	} else {
		ch, rate := "2", "192k"
		if j.Channels == 6 {
			ch, rate = "6", "384k"
		}
		a = append(a, "-c:a", "aac", "-ac", ch, "-b:a", rate)
	}
	return append(a, "-sn", "-dn", "-map_chapters", "-1", "-max_muxing_queue_size", "4096")
}

// SubtitleArgs: one text subtitle stream → WebVTT, timed from the same
// keyframe as the video (-ss), flushed per cue so <track> sees cues early.
// The whole file has to be read for that (subtitles are interleaved), so the
// read rate is capped at readRate× real time after an initial burst.
func SubtitleArgs(j *Job, start float64, readRate float64) []string {
	var pre []string
	if readRate > 0 {
		burst := j.Burst
		if burst <= 0 {
			burst = 60
		}
		pre = []string{"-readrate", fmtSeconds(readRate), "-readrate_initial_burst", fmtSeconds(burst)}
	}
	a := append(inputArgs(j, start, pre...), "-map", "0:"+strconv.Itoa(j.Stream))
	if start > 0 {
		a = append(a, "-output_ts_offset", fmtSeconds(seekPad))
	}
	return append(a,
		"-c:s", "webvtt",
		"-flush_packets", "1",
		"-f", "webvtt", "pipe:1",
	)
}

// KeyframeArgs: ffprobe seeks like ffmpeg -ss (backward, to the keyframe at
// or before start) and prints the first few video packets plus the file's
// start time.
func KeyframeArgs(j *Job, start float64) []string {
	a := []string{"-hide_banner", "-v", "error"}
	if j.Auth != "" {
		a = append(a, "-headers", "Authorization: "+j.Auth+"\r\n")
	}
	return append(a,
		"-rw_timeout", "30000000",
		"-select_streams", "V:0",
		"-read_intervals", fmtSeconds(start)+"%+#8",
		"-show_entries", "packet=pts_time,dts_time,flags:format=start_time",
		"-of", "json",
		j.Input,
	)
}

// ParseKeyframe reads KeyframeArgs' output: the first keyframe's time,
// relative to the file's start time.
func ParseKeyframe(out []byte) (float64, error) {
	var p struct {
		Packets []struct {
			PTS   string `json:"pts_time"`
			DTS   string `json:"dts_time"`
			Flags string `json:"flags"`
		} `json:"packets"`
		Format struct {
			StartTime string `json:"start_time"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &p); err != nil {
		return 0, errors.New("unreadable ffprobe output")
	}
	base, _ := strconv.ParseFloat(p.Format.StartTime, 64)
	for _, pk := range p.Packets {
		if !strings.Contains(pk.Flags, "K") {
			continue
		}
		ts := pk.PTS
		if ts == "" || ts == "N/A" {
			ts = pk.DTS
		}
		v, err := strconv.ParseFloat(ts, 64)
		if err != nil {
			continue
		}
		return max(0, v-base), nil
	}
	return 0, errors.New("no keyframe found")
}

// fmtSeconds prints seconds with millisecond precision (what MKV stores) and
// no exponent.
func fmtSeconds(s float64) string {
	return strconv.FormatFloat(s, 'f', 3, 64)
}

var urlPattern = regexp.MustCompile(`(?i)\b(https?|tcp|tls)://\S+`)

// sanitize strips the input URL and credentials from ffmpeg's stderr before
// it is logged.
func sanitize(stderr string, j *Job) string {
	if j.Input != "" {
		stderr = strings.ReplaceAll(stderr, j.Input, "<input>")
	}
	if j.Auth != "" {
		stderr = strings.ReplaceAll(stderr, j.Auth, "<auth>")
	}
	stderr = urlPattern.ReplaceAllString(stderr, "<url>")
	if len(stderr) > 600 {
		stderr = stderr[len(stderr)-600:]
	}
	return strings.TrimSpace(stderr)
}
