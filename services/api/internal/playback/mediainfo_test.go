package playback

import (
	"encoding/json"
	"testing"

	"martytv/api/internal/integrations/torrserver"
)

// probeOf decodes ffprobe JSON (the shape of `ffprobe -show_streams
// -show_format -of json`, trimmed) the way the TorrServer client does.
func probeOf(t *testing.T, js string) *torrserver.Probe {
	t.Helper()
	var p torrserver.Probe
	if err := json.Unmarshal([]byte(js), &p); err != nil {
		t.Fatal(err)
	}
	return &p
}

func TestMediaInfoVideoDetails(t *testing.T) {
	type want struct {
		profile, pixFmt, codecString string
		bits, level                  int
		interlaced                   *bool
	}
	no, yes := false, true
	for _, tc := range []struct {
		name, video string
		want        want
	}{
		{
			// Real ffprobe 7 output for a libx264 -profile:v high10 clip.
			name: "h264 High 10",
			video: `{"index":0,"codec_name":"h264","profile":"High 10","codec_type":"video","mime_codec_string":"avc1.6e000d",
				"width":320,"height":240,"pix_fmt":"yuv420p10le","level":13,"field_order":"progressive","bits_per_raw_sample":"10",
				"disposition":{"default":0,"attached_pic":0}}`,
			want: want{profile: "High 10", pixFmt: "yuv420p10le", codecString: "avc1.6e000d", bits: 10, level: 13, interlaced: &no},
		},
		{
			name: "h264 High 8-bit, no mime string (older ffprobe)",
			video: `{"index":0,"codec_name":"h264","profile":"High","codec_type":"video","width":1920,"height":1080,
				"pix_fmt":"yuv420p","level":41,"bits_per_raw_sample":"8"}`,
			want: want{profile: "High", pixFmt: "yuv420p", bits: 8, level: 41},
		},
		{
			name: "hevc Main 10",
			video: `{"index":0,"codec_name":"hevc","profile":"Main 10","codec_type":"video","width":3840,"height":2160,
				"pix_fmt":"yuv420p10le","level":150}`,
			want: want{profile: "Main 10", pixFmt: "yuv420p10le", bits: 10, level: 150},
		},
		{
			name: "mpeg2 interlaced",
			video: `{"index":0,"codec_name":"mpeg2video","profile":"Main","codec_type":"video","width":720,"height":576,
				"pix_fmt":"yuv420p","level":8,"field_order":"tt"}`,
			want: want{profile: "Main", pixFmt: "yuv420p", bits: 8, level: 8, interlaced: &yes},
		},
		{
			name: "pix_fmt unknown: bits from bits_per_raw_sample",
			video: `{"index":0,"codec_name":"h264","codec_type":"video","width":1280,"height":720,"pix_fmt":"unknown",
				"level":-99,"bits_per_raw_sample":"10","profile":"unknown"}`,
			want: want{bits: 10},
		},
		{
			name:  "only a profile name",
			video: `{"index":0,"codec_name":"hevc","codec_type":"video","width":1280,"height":720,"profile":"Main 10"}`,
			want:  want{profile: "Main 10", bits: 10},
		},
		{
			name:  "p010 hw format",
			video: `{"index":0,"codec_name":"hevc","codec_type":"video","width":1280,"height":720,"pix_fmt":"p010le"}`,
			want:  want{pixFmt: "p010le", bits: 10},
		},
		{
			name: "mpeg4 part 2 (xvid)",
			video: `{"index":0,"codec_name":"mpeg4","profile":"Advanced Simple Profile","codec_type":"video","width":720,"height":304,
				"pix_fmt":"yuv420p","level":5}`,
			want: want{profile: "Advanced Simple Profile", pixFmt: "yuv420p", bits: 8, level: 5},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mi := mediaInfoFrom(probeOf(t, `{"streams":[`+tc.video+`],"format":{"format_name":"matroska,webm","duration":"60"}}`))
			s := func(p *string) string {
				if p == nil {
					return ""
				}
				return *p
			}
			i := func(p *int) int {
				if p == nil {
					return 0
				}
				return *p
			}
			if s(mi.VideoProfile) != tc.want.profile || s(mi.PixFmt) != tc.want.pixFmt || s(mi.VideoCodecString) != tc.want.codecString ||
				i(mi.BitDepth) != tc.want.bits || i(mi.VideoLevel) != tc.want.level {
				t.Fatalf("got profile=%q pix=%q str=%q bits=%d level=%d", s(mi.VideoProfile), s(mi.PixFmt), s(mi.VideoCodecString), i(mi.BitDepth), i(mi.VideoLevel))
			}
			if (mi.Interlaced == nil) != (tc.want.interlaced == nil) || (mi.Interlaced != nil && *mi.Interlaced != *tc.want.interlaced) {
				t.Fatalf("interlaced %v", mi.Interlaced)
			}
			if mi.ProbeVersion != mediaInfoVersion {
				t.Fatalf("probe version %d", mi.ProbeVersion)
			}
		})
	}
}

func TestMediaInfoCoverArtIgnored(t *testing.T) {
	mi := mediaInfoFrom(probeOf(t, `{"streams":[
		{"index":0,"codec_name":"mjpeg","codec_type":"video","width":600,"height":800,"pix_fmt":"yuvj420p","disposition":{"attached_pic":1}},
		{"index":1,"codec_name":"h264","profile":"High 10","codec_type":"video","width":1920,"height":1080,"pix_fmt":"yuv420p10le"}],
		"format":{"format_name":"matroska,webm"}}`))
	if mi.VideoCodec == nil || *mi.VideoCodec != "h264" || mi.BitDepth == nil || *mi.BitDepth != 10 {
		t.Fatalf("%+v", mi)
	}
}

func TestPixFmtDepth(t *testing.T) {
	for f, want := range map[string]int{
		"yuv420p": 8, "yuvj420p": 8, "yuv422p": 8, "yuv444p": 8, "nv12": 8, "gray": 8,
		"yuv420p10le": 10, "yuv420p10be": 10, "yuv422p10le": 10, "yuv444p12le": 12, "gray10le": 10, "yuv420p9le": 9,
		"p010le": 10, "p016le": 16, "yuva444p16le": 16, "": 0, "unknown": 0, "rgb48le": 0,
	} {
		if got := pixFmtDepth(f); got != want {
			t.Errorf("%s: %d, want %d", f, got, want)
		}
	}
}

func TestMediaInfoChaptersToMarkers(t *testing.T) {
	// ffprobe -show_chapters prints times as strings; a re-encoder may not.
	p := probeOf(t, `{"format":{"format_name":"matroska,webm","duration":"1420.5"},"streams":[],
		"chapters":[
			{"id":1,"start_time":"0.000000","end_time":"88.400000","tags":{"title":"Opening"}},
			{"id":2,"start_time":88.4,"end_time":1330,"tags":{"title":"Part A"}},
			{"id":3,"start_time":"1330.000000","end_time":"1420.500000","tags":{"title":"Ending"}},
			{"id":4,"start_time":"1420.500000","end_time":"1420.500000","tags":{}}]}`)
	mi := mediaInfoFrom(p)
	if mi.ProbeVersion != 3 || len(mi.Chapters) != 3 || mi.Chapters[0].Title != "Opening" || mi.Chapters[2].EndSeconds != 1420.5 {
		t.Fatalf("chapters: %+v", mi.Chapters)
	}
	s := &Service{}
	got := s.markersFor(t.Context(), &source{MediaInfo: mi}, nil, nil, nil, *mi.DurationSeconds)
	if len(got) != 2 || got[0].Kind != "opening" || got[0].EndSeconds != 88.4 || got[1].Kind != "ending" || got[1].StartSeconds != 1330 || got[1].Source != "chapters" {
		t.Fatalf("markers: %+v", got)
	}
}
