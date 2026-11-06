package sources

import (
	"context"
	"sync/atomic"
	"time"
)

// Fake is a configurable in-memory provider for tests (torrent and/or
// online). It is safe for concurrent use once built.
type Fake struct {
	Desc     Info
	Torrents []Torrent
	Items    []Variant
	Stream   *Stream
	Err      error         // returned by searches/variants
	ProbeErr error         // returned by Probe
	Delay    time.Duration // simulated latency (honours ctx)
	Calls    atomic.Int32
}

func (f *Fake) Info() Info { return f.Desc }

func (f *Fake) Probe(context.Context) error { return f.ProbeErr }

func (f *Fake) wait(ctx context.Context) error {
	f.Calls.Add(1)
	if f.Delay <= 0 {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(f.Delay):
		return nil
	}
}

// FakeTorrent is a Fake that implements TorrentProvider.
type FakeTorrent struct{ Fake }

func (f *FakeTorrent) SearchTorrents(ctx context.Context, _ Title) (*TorrentResult, error) {
	if err := f.wait(ctx); err != nil {
		return nil, err
	}
	if f.Err != nil {
		return nil, f.Err
	}
	return &TorrentResult{Torrents: f.Torrents}, nil
}

// FakeOnline is a Fake that implements OnlineProvider.
type FakeOnline struct{ Fake }

func (f *FakeOnline) Variants(ctx context.Context, t Title) ([]Variant, error) {
	if err := f.wait(ctx); err != nil {
		return nil, err
	}
	if f.Err != nil {
		return nil, f.Err
	}
	var out []Variant
	for _, v := range f.Items {
		if t.Season != 0 && v.Season != 0 && v.Season != t.Season {
			continue
		}
		if t.Episode != 0 && v.Episode != 0 && v.Episode != t.Episode {
			continue
		}
		out = append(out, v)
	}
	return out, nil
}

func (f *FakeOnline) Resolve(ctx context.Context, v Variant, quality int) (*Stream, error) {
	if f.Stream == nil {
		return nil, ErrNotFound
	}
	s := *f.Stream
	if quality != 0 {
		s.Quality = quality
	}
	return &s, nil
}
