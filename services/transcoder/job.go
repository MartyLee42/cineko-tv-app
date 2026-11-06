package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Job is what the API asks for. The API builds it from its own records (the
// TorrServer URL of a source the caller may play) and signs the exact JSON
// body; nothing in it comes from a browser unchecked.
//
//	POST /v1/{remux|keyframe|subtitles|hls}
//	X-Job-Signature: hex(HMAC-SHA256(key, body)),  key = HMAC-SHA256(TRANSCODER_SECRET, "martytv/transcoder/job/v1")
//
// The API side mirrors this in services/api/internal/playback/compat.go.
type Job struct {
	V int `json:"v"`
	// Kind must match the endpoint (a remux signature can't start a subtitle job).
	Kind  string `json:"kind"`
	Input string `json:"input"`
	// Auth is the Authorization header value for Input (TorrServer basic auth).
	Auth string `json:"auth,omitempty"`
	// Audio is the global stream index of the audio track; nil = the first one.
	Audio *int `json:"audio,omitempty"`
	// AudioCopy keeps the audio as is (already AAC).
	AudioCopy bool `json:"audio_copy,omitempty"`
	// Channels: 2 (default, stereo downmix) or 6 (5.1).
	Channels int `json:"channels,omitempty"`
	// HVC1 tags HEVC video as hvc1 (Safari only plays that tag).
	HVC1 bool `json:"hvc1,omitempty"`
	// Video: "" copies the video stream; "h264" re-encodes it with libx264
	// (codecs the player can't decode; the API checks codec and size).
	Video string `json:"video,omitempty"`
	// Start (seconds) of the requested position.
	Start float64 `json:"start,omitempty"`
	// Stream is the subtitle job's global stream index.
	Stream int `json:"stream,omitempty"`
	// Burst (subtitles): seconds of media read at full speed before the read rate cap applies.
	Burst float64 `json:"burst,omitempty"`
	// Owner (hls): who may read the session's files (the API's source id);
	// file requests must name the same owner (hls.go).
	Owner string `json:"owner,omitempty"`
	// Exp is the unix time after which the job is refused.
	Exp int64 `json:"exp"`

	// threads: libx264 threads (Config.VideoThreads), set by the server.
	threads int
}

const (
	KindRemux     = "remux"
	KindKeyframe  = "keyframe"
	KindSubtitles = "subtitles"
	KindHLS       = "hls"

	// VideoH264: Job.Video value that re-encodes the video.
	VideoH264 = "h264"

	maxStart   = 48 * 3600
	maxJobBody = 8 << 10
	// maxExpiry bounds how far in the future a job may expire (clock skew + latency).
	maxExpiry = 5 * time.Minute
)

// ownerPattern: empty, or an id (the API sends a UUID).
var ownerPattern = regexp.MustCompile(`^[A-Za-z0-9-]{0,64}$`)

var (
	errBadSignature = errors.New("bad signature")
	errExpired      = errors.New("job expired")
	errBadJob       = errors.New("invalid job")
)

func jobKey(secret []byte) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("martytv/transcoder/job/v1"))
	return m.Sum(nil)
}

// Sign returns the X-Job-Signature value for body.
func Sign(key, body []byte) string {
	m := hmac.New(sha256.New, key)
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

// ParseJob checks the signature (constant time) before looking at the body,
// then decodes and validates it for the endpoint's kind.
func ParseJob(key, body []byte, sig, kind string, now time.Time) (*Job, error) {
	want, err := hex.DecodeString(sig)
	if err != nil || len(want) != sha256.Size {
		return nil, errBadSignature
	}
	m := hmac.New(sha256.New, key)
	m.Write(body)
	if !hmac.Equal(want, m.Sum(nil)) {
		return nil, errBadSignature
	}
	var j Job
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&j); err != nil {
		return nil, errBadJob
	}
	if j.Exp < now.Unix() {
		return nil, errExpired
	}
	if j.V != 1 || j.Kind != kind || j.Exp > now.Add(maxExpiry).Unix() {
		return nil, errBadJob
	}
	if err := j.validate(); err != nil {
		return nil, err
	}
	return &j, nil
}

func (j *Job) validate() error {
	u, err := url.Parse(j.Input)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || len(j.Input) > 2048 {
		return errBadJob
	}
	// The header goes to ffmpeg's -headers: no line breaks (header injection).
	if strings.ContainsAny(j.Auth, "\r\n") || len(j.Auth) > 1024 {
		return errBadJob
	}
	if j.Audio != nil && (*j.Audio < 0 || *j.Audio > 1023) {
		return errBadJob
	}
	if j.Channels != 0 && j.Channels != 2 && j.Channels != 6 {
		return errBadJob
	}
	if j.Video != "" && (j.Video != VideoH264 || j.HVC1) {
		return errBadJob
	}
	if math.IsNaN(j.Start) || math.IsInf(j.Start, 0) || j.Start < 0 || j.Start > maxStart {
		return errBadJob
	}
	if math.IsNaN(j.Burst) || math.IsInf(j.Burst, 0) || j.Burst < 0 || j.Burst > maxStart {
		return errBadJob
	}
	if j.Stream < 0 || j.Stream > 1023 {
		return errBadJob
	}
	if !ownerPattern.MatchString(j.Owner) {
		return errBadJob
	}
	return nil
}
