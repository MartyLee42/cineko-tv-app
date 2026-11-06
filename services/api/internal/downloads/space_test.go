package downloads

import (
	"testing"
	"time"
)

func TestAvailable(t *testing.T) {
	capGB := 100.0
	cases := []struct {
		name   string
		disk   DiskStats
		st     Settings
		used   int64
		others int64
		want   int64
	}{
		{"free minus reserve", DiskStats{Free: 57 * gb}, Settings{ReserveGB: 15}, 0, 0, 42 * gb},
		{"running downloads claim their rest", DiskStats{Free: 57 * gb}, Settings{ReserveGB: 15}, 0, 10 * gb, 32 * gb},
		{"library cap binds", DiskStats{Free: 57 * gb}, Settings{ReserveGB: 15, MaxLibraryGB: &capGB}, 90 * gb, 0, 10 * gb},
		{"below reserve is negative", DiskStats{Free: 10 * gb}, Settings{ReserveGB: 15}, 0, 0, -5 * gb},
	}
	for _, c := range cases {
		if got := available(c.disk, c.st, c.used, c.others); got != c.want {
			t.Errorf("%s: %d, want %d", c.name, got/gb, c.want/gb)
		}
	}
}

func TestPlanEviction(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	ago := func(d int) *time.Time { t := now.Add(-time.Duration(d) * 24 * time.Hour); return &t }
	hoursAgo := func(h int) *time.Time { t := now.Add(-time.Duration(h) * time.Hour); return &t }
	done := func(id string, size int64, completed *time.Time) candidate {
		return candidate{ID: id, Size: size * gb, Status: StatusDone, CompletedAt: completed}
	}
	old40 := done("old40", 10, ago(40))
	old35 := done("old35", 10, ago(35))
	young := done("young", 50, ago(10)) // younger than keep_days
	pinned := done("pinned", 50, ago(90))
	pinned.Pinned = true
	watchedRecently := done("watched", 50, ago(90))
	watchedRecently.LastWatchedAt = hoursAgo(3)
	watchedLong := done("watched-long", 10, ago(90))
	watchedLong.LastWatchedAt = ago(20) // watched 20 days ago: kept until day 50
	running := candidate{ID: "running", Size: 50 * gb, Status: StatusDownloading}
	waiting := candidate{ID: "waiting", Size: 5 * gb, Status: StatusWaitingSpace}
	all := []candidate{young, old35, pinned, watchedRecently, old40, running, waiting, watchedLong}

	cases := []struct {
		name     string
		cands    []candidate
		need     int64
		keepDays int
		want     []string
		freeable int64
	}{
		{"nothing needed", all, 0, 30, nil, 0},
		{"oldest first, only what is needed", all, 5 * gb, 30, []string{"old40"}, 10 * gb},
		{"two oldest", all, 15 * gb, 30, []string{"old40", "old35"}, 20 * gb},
		{"not enough: delete nothing (never younger than keep_days, pinned, recent, running)", all, 25 * gb, 30, nil, 20 * gb},
		{"shorter keep_days allows more", all, 25 * gb, 7, []string{"old40", "old35", "watched-long"}, 30 * gb},
		{"…and younger ones when needed", all, 60 * gb, 7, []string{"old40", "old35", "watched-long", "young"}, 80 * gb},
		{"recently played kept even when old", []candidate{watchedRecently}, gb, 1, nil, 0},
		{"last watched counts as use", []candidate{watchedLong}, gb, 30, nil, 0},
		{"last watched older than keep_days", []candidate{watchedLong}, gb, 15, []string{"watched-long"}, 10 * gb},
	}
	for _, c := range cases {
		v, freeable := planEviction(c.cands, c.need, now, c.keepDays)
		var ids []string
		for _, x := range v {
			ids = append(ids, x.ID)
		}
		if len(ids) != len(c.want) || freeable != c.freeable {
			t.Errorf("%s: got %v (freeable %d GB), want %v (%d GB)", c.name, ids, freeable/gb, c.want, c.freeable/gb)
			continue
		}
		for i := range ids {
			if ids[i] != c.want[i] {
				t.Errorf("%s: got %v, want %v", c.name, ids, c.want)
			}
		}
	}
}

func TestKeepUntil(t *testing.T) {
	c := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)
	w := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	got := keepUntil(candidate{Status: StatusDone, CompletedAt: &c, LastWatchedAt: &w}, 30)
	if got == nil || !got.Equal(w.Add(30*24*time.Hour)) {
		t.Fatalf("keep until %v", got)
	}
	if keepUntil(candidate{Status: StatusDone, CompletedAt: &c, Pinned: true}, 30) != nil {
		t.Fatal("pinned has no keep-until")
	}
	if keepUntil(candidate{Status: StatusDownloading}, 30) != nil {
		t.Fatal("incomplete has no keep-until")
	}
}
