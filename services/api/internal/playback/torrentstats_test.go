package playback

import (
	"testing"

	"martytv/api/internal/integrations/torrserver"
)

func TestTorrentStats(t *testing.T) {
	files := []torrserver.FileStat{{ID: 1, Path: "a.mkv", Length: 10}}
	cases := []struct {
		t     torrserver.Torrent
		stage string
	}{
		{torrserver.Torrent{Stat: torrserver.StatAdded}, "metadata"},
		{torrserver.Torrent{Stat: torrserver.StatAdded, FileStats: files}, "idle"},
		{torrserver.Torrent{Stat: torrserver.StatGettingInfo, TotalPeers: 5}, "metadata"},
		{torrserver.Torrent{Stat: torrserver.StatPreload, FileStats: files}, "preloading"},
		{torrserver.Torrent{Stat: torrserver.StatWorking, FileStats: files}, "working"},
		{torrserver.Torrent{Stat: torrserver.StatClosed, FileStats: files}, "idle"},
	}
	for i, c := range cases {
		if got := torrentStats(&c.t).Stage; got != c.stage {
			t.Errorf("case %d: stage %q, want %q", i, got, c.stage)
		}
	}
	got := torrentStats(&torrserver.Torrent{
		Stat: torrserver.StatPreload, ActivePeers: 12, TotalPeers: 80, ConnectedSeeders: 9,
		DownloadSpeed: 2.5e6, PreloadedBytes: 12 << 20, PreloadSize: 20 << 20,
	})
	want := TorrentStats{Peers: 12, Seeders: 9, DownloadSpeedBps: 2.5e6, PreloadedBytes: 12 << 20, TotalPeers: 80, PreloadSize: 20 << 20, Stage: "preloading"}
	if *got != want {
		t.Fatalf("stats %+v, want %+v", *got, want)
	}
}
