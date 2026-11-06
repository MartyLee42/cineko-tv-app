package downloads

import (
	"sort"
	"syscall"
	"time"
)

// DiskStats is the filesystem holding the library.
type DiskStats struct {
	Total int64
	Free  int64 // available to unprivileged users (statfs Bavail)
}

// StatFS reads disk stats with statfs(2).
func StatFS(path string) (DiskStats, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return DiskStats{}, err
	}
	bs := int64(st.Bsize) //nolint:unconvert // int32 on some platforms
	return DiskStats{Total: int64(st.Blocks) * bs, Free: int64(st.Bavail) * bs}, nil
}

// Settings are the admin storage settings (library_settings).
type Settings struct {
	ReserveGB    float64  `json:"reserve_gb"`
	MaxLibraryGB *float64 `json:"max_library_gb"`
	KeepDays     int      `json:"keep_days"`
}

const gb = int64(1) << 30

func (s Settings) reserveBytes() int64 { return int64(s.ReserveGB * float64(gb)) }

func (s Settings) maxLibraryBytes() int64 {
	if s.MaxLibraryGB == nil {
		return 0
	}
	return int64(*s.MaxLibraryGB * float64(gb))
}

// available is the room for more downloaded bytes right now: the smaller of
// (free − reserve) and (library cap − used), minus what running downloads
// still have to write. May be negative.
func available(disk DiskStats, s Settings, libraryUsed, othersRemaining int64) int64 {
	a := disk.Free - s.reserveBytes() - othersRemaining
	if lim := s.maxLibraryBytes(); lim > 0 {
		a = min(a, lim-libraryUsed-othersRemaining)
	}
	return a
}

// candidate is a download eviction may consider.
type candidate struct {
	ID            string
	Size          int64 // bytes on disk
	Status        string
	Pinned        bool
	CompletedAt   *time.Time
	LastWatchedAt *time.Time
}

// lastUse is when the download was last useful: completed or last watched.
func (c candidate) lastUse() time.Time {
	var t time.Time
	if c.CompletedAt != nil {
		t = *c.CompletedAt
	}
	if c.LastWatchedAt != nil && c.LastWatchedAt.After(t) {
		t = *c.LastWatchedAt
	}
	return t
}

// recentPlayWindow: anything played this recently is never evicted.
const recentPlayWindow = 24 * time.Hour

// evictable applies the rules: completed, not pinned, not played in the last
// 24 h, and last used (completed / watched) more than keepDays ago.
func evictable(c candidate, now time.Time, keepDays int) bool {
	if c.Status != "done" || c.Pinned || c.CompletedAt == nil {
		return false
	}
	if c.LastWatchedAt != nil && now.Sub(*c.LastWatchedAt) < recentPlayWindow {
		return false
	}
	return now.Sub(c.lastUse()) > time.Duration(keepDays)*24*time.Hour
}

// planEviction picks the downloads to delete to free need bytes: evictable
// ones, oldest last use first. When even all of them aren't enough it picks
// nothing (deleting would not help) and reports how much it could free.
func planEviction(cands []candidate, need int64, now time.Time, keepDays int) (victims []candidate, freeable int64) {
	if need <= 0 {
		return nil, 0
	}
	var ok []candidate
	for _, c := range cands {
		if evictable(c, now, keepDays) {
			ok = append(ok, c)
		}
	}
	sort.SliceStable(ok, func(i, j int) bool {
		a, b := ok[i].lastUse(), ok[j].lastUse()
		if !a.Equal(b) {
			return a.Before(b)
		}
		return ok[i].ID < ok[j].ID
	})
	var freed int64
	for _, c := range ok {
		if freed >= need {
			break
		}
		victims = append(victims, c)
		freed += c.Size
	}
	if freed < need {
		return nil, freed
	}
	return victims, freed
}

// keepUntil is when a completed download may first be evicted.
func keepUntil(c candidate, keepDays int) *time.Time {
	if c.Status != "done" || c.Pinned || c.CompletedAt == nil {
		return nil
	}
	t := c.lastUse().Add(time.Duration(keepDays) * 24 * time.Hour).UTC()
	return &t
}
