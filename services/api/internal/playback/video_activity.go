package playback

import (
	"io"
	"sync/atomic"
	"time"
)

// lastVideoStream is when a YouTube stream (/api/v1/vstream) was last
// requested or sent bytes, in unix nanoseconds (0 = never since start). The
// nightly Invidious restart (internal/ivrestart) postpones itself while it is
// recent, so nobody's video stops mid-way.
var lastVideoStream atomic.Int64

func noteVideoStream() { lastVideoStream.Store(time.Now().UnixNano()) }

// LastVideoStream reports the last YouTube stream activity (zero = none).
func LastVideoStream() time.Time {
	n := lastVideoStream.Load()
	if n == 0 {
		return time.Time{}
	}
	return time.Unix(0, n)
}

// activityReader marks video activity on every Read: a progressive MP4 is
// one long response, so the request time alone would go stale mid-film.
type activityReader struct{ io.ReadCloser }

func (a activityReader) Read(p []byte) (int, error) {
	noteVideoStream()
	return a.ReadCloser.Read(p)
}
