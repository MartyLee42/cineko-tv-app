package main

// The asset archive: hashed app files (assets/*) of earlier releases, kept on
// the data volume for a while after a deploy. A page opened before the deploy
// still asks for its own release's lazy chunks; without them it breaks. At
// start the service adds its own build's assets (hashed names never collide),
// notes which files this release has, and prunes: a file goes once it is
// older than archiveKeepDays AND none of the last archiveKeepReleases releases
// had it. serveSPA falls back to the archive for /assets/* only — index.html,
// sw.js and the manifest always come from the current build.
// The web image does the same for the PWA and the TV app
// (deployments/web-entrypoint.sh).

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
)

const (
	archiveKeepDays     = 14
	archiveKeepReleases = 3
)

// archiveAssets copies build/assets into archive/assets and prunes the archive.
// archive is one app's directory (e.g. /data/asset-archive/music).
func archiveAssets(build, archive string, now time.Time) error {
	src := filepath.Join(build, "assets")
	names, err := assetNames(src)
	if err != nil {
		return err
	}
	dst := filepath.Join(archive, "assets")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	for _, n := range names {
		to := filepath.Join(dst, n)
		if _, err := os.Stat(to); errors.Is(err, fs.ErrNotExist) {
			if err := copyFile(filepath.Join(src, n), to); err != nil {
				return err
			}
		}
		// The running release's files are "new" again (never pruned while live).
		_ = os.Chtimes(to, now, now)
	}
	if err := recordRelease(filepath.Join(archive, "releases"), names, now); err != nil {
		return err
	}
	return pruneArchive(archive, now)
}

// assetNames lists the files under dir (relative, slash-separated, sorted).
func assetNames(dir string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			rel, _ := filepath.Rel(dir, p)
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(out)
	return out, err
}

func copyFile(from, to string) error {
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := to + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	// Whole files only: a request never sees half a chunk.
	return os.Rename(tmp, to)
}

// recordRelease writes the release's file list (unless the newest list is the same build).
func recordRelease(dir string, names []string, now time.Time) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	lists, err := releaseLists(dir)
	if err != nil {
		return err
	}
	body := strings.Join(names, "\n") + "\n"
	if len(lists) > 0 {
		if last, err := os.ReadFile(filepath.Join(dir, lists[len(lists)-1])); err == nil && string(last) == body {
			return nil
		}
	}
	p := filepath.Join(dir, fmt.Sprintf("%020d.list", now.UnixNano()))
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		return err
	}
	return os.Chtimes(p, now, now)
}

// releaseLists: the release list files, oldest first.
func releaseLists(dir string) ([]string, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".list") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out, nil
}

// pruneArchive deletes old files no recent release has, and old release lists.
func pruneArchive(archive string, now time.Time) error {
	dir := filepath.Join(archive, "releases")
	lists, err := releaseLists(dir)
	if err != nil {
		return err
	}
	keep := map[string]bool{}
	recent := lists[max(0, len(lists)-archiveKeepReleases):]
	for _, l := range recent {
		f, err := os.Open(filepath.Join(dir, l))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if t := sc.Text(); t != "" {
				keep[t] = true
			}
		}
		f.Close()
	}
	cutoff := now.Add(-archiveKeepDays * 24 * time.Hour)
	assets := filepath.Join(archive, "assets")
	names, err := assetNames(assets)
	if err != nil {
		return err
	}
	for _, n := range names {
		p := filepath.Join(assets, n)
		if keep[n] {
			continue
		}
		if fi, err := os.Stat(p); err == nil && fi.ModTime().Before(cutoff) {
			_ = os.Remove(p)
		}
	}
	// Lists: the recent ones, plus any still younger than the cutoff.
	for _, l := range lists {
		if slices.Contains(recent, l) {
			continue
		}
		if fi, err := os.Stat(filepath.Join(dir, l)); err == nil && fi.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, l))
		}
	}
	return nil
}
