package watch

import (
	"encoding/json"
	"testing"
)

func TestParseQuality(t *testing.T) {
	for _, bad := range []string{``, `{`, `"x"`, `{"app":"phone"}`, `{"app":1}`} {
		if parseQuality(json.RawMessage(bad)) != nil {
			t.Errorf("%q should be dropped", bad)
		}
	}
	q := parseQuality(json.RawMessage(`{"app":"tv","engine":"an-engine-name-that-is-too-long","startup_ms":0,
		"watched_s":-5,"stalls":2,"stall_ms":100,"longest_stall_ms":900,"dropped_frames":50,"total_frames":10,"height":1080}`))
	if q == nil {
		t.Fatal("valid sample dropped")
	}
	if len(q.Engine) != 16 || q.StartupMS != nil || q.WatchedS != 0 || q.LongestStallMS != 100 || q.DroppedFrames != 10 || *q.Height != 1080 {
		t.Fatalf("not bounded: %+v", q)
	}
}
