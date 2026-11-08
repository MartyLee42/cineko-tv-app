package alerts

import (
	"testing"
	"time"
)

var fixedNow = time.Date(2026, 11, 7, 21, 30, 0, 0, time.UTC)

func fail(kind string) Observation  { return Observation{Kind: kind, Source: SourceMonitor} }
func okObs(kind string) Observation { return Observation{Kind: kind, OK: true, Source: SourceMonitor} }

func TestMachineOpensAfterConsecutiveFailures(t *testing.T) {
	m := NewMachine()
	now := fixedNow
	for i := 0; i < 2; i++ {
		if _, ok := m.Observe(now, fail(KindTMDB)); ok {
			t.Fatalf("opened after %d failures", i+1)
		}
		now = now.Add(time.Minute)
	}
	// A success in between resets the count.
	m.Observe(now, okObs(KindTMDB))
	for i := 0; i < 2; i++ {
		now = now.Add(time.Minute)
		if _, ok := m.Observe(now, fail(KindTMDB)); ok {
			t.Fatal("opened without 3 in a row")
		}
	}
	now = now.Add(time.Minute)
	e, ok := m.Observe(now, Observation{Kind: KindTMDB, Cause: "unauthorized", Source: SourceMonitor})
	if !ok || e.Type != EventOpened || e.Cause != "unauthorized" || !m.Open(KindTMDB) {
		t.Fatalf("not opened: %+v %v", e, ok)
	}
	if e.OpenedAt != now.Add(-2*time.Minute) {
		t.Fatalf("dated %v, want the first failure %v", e.OpenedAt, now.Add(-2*time.Minute))
	}
	// Still failing: nothing new to say.
	if _, ok := m.Observe(now.Add(time.Minute), fail(KindTMDB)); ok {
		t.Fatal("repeat failure announced")
	}
}

func TestMachineRecoversAfterTwoOKs(t *testing.T) {
	m := NewMachine()
	now := fixedNow
	for i := 0; i < 3; i++ {
		m.Observe(now, fail(KindProwlarr))
		now = now.Add(time.Minute)
	}
	if _, ok := m.Observe(now, okObs(KindProwlarr)); ok {
		t.Fatal("closed after one OK")
	}
	now = now.Add(time.Minute)
	e, ok := m.Observe(now, okObs(KindProwlarr))
	if !ok || e.Type != EventRecovered || e.Duration() != 4*time.Minute || m.Open(KindProwlarr) {
		t.Fatalf("recover %+v %v dur=%v", e, ok, e.Duration())
	}
	if _, ok := m.Observe(now.Add(time.Minute), okObs(KindProwlarr)); ok {
		t.Fatal("double recovery")
	}
}

func TestMachineConfirmedHostReports(t *testing.T) {
	m := NewMachine()
	now := fixedNow
	// The watchdog restarted the companion earlier: the note waits for the incident.
	if _, ok := m.Note(now, KindYouTube, "companion_restarted"); ok {
		t.Fatal("note announced without an incident")
	}
	now = now.Add(4 * time.Minute)
	e, ok := m.Observe(now, Observation{Kind: KindYouTube, Cause: "streams", Source: SourceHost, Confirmed: true})
	if !ok || e.Type != EventOpened || e.OpenedAt != now || len(e.Notes) != 1 || e.Notes[0] != "companion_restarted" {
		t.Fatalf("host open %+v", e)
	}
	// A later action updates it quietly.
	e, ok = m.Observe(now.Add(2*time.Minute), Observation{Kind: KindYouTube, Cause: "streams", Source: SourceHost, Confirmed: true,
		Actions: []string{"invidious_restarted"}})
	if !ok || e.Type != EventUpdated || len(e.Notes) != 2 {
		t.Fatalf("update %+v", e)
	}
	// One confirmed OK closes it.
	e, ok = m.Observe(now.Add(4*time.Minute), Observation{Kind: KindYouTube, OK: true, Source: SourceHost, Confirmed: true})
	if !ok || e.Type != EventRecovered {
		t.Fatalf("host recover %+v", e)
	}
}

func TestMachineOldPendingNotesDropped(t *testing.T) {
	m := NewMachine()
	m.Note(fixedNow, KindVPN, "vpn_restarted")
	e, _ := m.Observe(fixedNow.Add(time.Hour), Observation{Kind: KindVPN, Source: SourceHost, Confirmed: true})
	if len(e.Notes) != 0 {
		t.Fatalf("stale note kept: %v", e.Notes)
	}
}

func TestMachineRemindersAndStale(t *testing.T) {
	m := NewMachine()
	now := fixedNow
	m.Observe(now, Observation{Kind: KindVPN, Source: SourceHost, Confirmed: true})
	m.Observe(now, Observation{Kind: KindDisk, Source: SourceMonitor, Confirmed: true})
	// Keep the disk observed; the VPN reporter goes quiet.
	for i := 1; i <= 6*60; i++ {
		now = fixedNow.Add(time.Duration(i) * time.Minute)
		m.Observe(now, fail(KindDisk))
		for _, e := range m.Tick(now) {
			switch {
			case e.Kind == KindVPN && e.Type == EventClosedSilently:
				if i != 21 {
					t.Fatalf("vpn closed at minute %d", i)
				}
			case e.Kind == KindDisk && e.Type == EventReminder:
				if i != 360 {
					t.Fatalf("disk reminder at minute %d", i)
				}
			default:
				t.Fatalf("unexpected %+v at %d", e, i)
			}
		}
	}
	if m.Open(KindVPN) || !m.Open(KindDisk) {
		t.Fatal("states")
	}
	// Next reminder only 6 h later.
	if ev := m.Tick(now.Add(time.Hour)); len(ev) != 0 {
		// (disk not observed for an hour → stale is fine, but no reminder)
		for _, e := range ev {
			if e.Type == EventReminder {
				t.Fatal("reminder too soon")
			}
		}
	}
}

func TestMachineRestore(t *testing.T) {
	m := NewMachine()
	m.Restore(KindTMDB, "id-1", "", "", SourceMonitor, nil, fixedNow, fixedNow, fixedNow.Add(time.Hour))
	m.Observe(fixedNow.Add(61*time.Minute), okObs(KindTMDB))
	e, ok := m.Observe(fixedNow.Add(62*time.Minute), okObs(KindTMDB))
	if !ok || e.Type != EventRecovered || e.ID != "id-1" || e.Duration() != 62*time.Minute {
		t.Fatalf("%+v", e)
	}
}
