package playback

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

func TestActiveStreamsGauge(t *testing.T) {
	base := ActiveStreams()
	_, cancel := context.WithCancel(context.Background())
	r := newIdleReader(io.NopCloser(strings.NewReader("x")), cancel, time.Minute, streamMeta{})
	if ActiveStreams() != base+1 {
		t.Fatalf("open: %d", ActiveStreams())
	}
	_ = r.Close()
	_ = r.Close() // fasthttp may close twice; counted once
	if ActiveStreams() != base {
		t.Fatalf("closed: %d", ActiveStreams())
	}
}
