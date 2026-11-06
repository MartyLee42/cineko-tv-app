package downloads

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"sync/atomic"
	"time"
)

var (
	// errSizeMismatch: the upstream file isn't the size the source said.
	errSizeMismatch = errors.New("size mismatch")
	// errShortRead: upstream ended before the end of the file (retry).
	errShortRead = errors.New("upstream ended early")
	// errIdle: no bytes for too long (retry).
	errIdle = errors.New("upstream idle")
	// errNoSpace: the disk dropped below the reserve while writing.
	errNoSpace = errors.New("insufficient space")
)

// writeError wraps local disk failures (permanent: failed/write_error).
type writeError struct{ err error }

func (e *writeError) Error() string { return "write: " + e.err.Error() }
func (e *writeError) Unwrap() error { return e.err }

// opener opens the file at offset (an HTTP Range request to TorrServer).
type opener func(ctx context.Context, offset int64) (*http.Response, error)

type transferOpts struct {
	CheckpointBytes int64         // fsync + report at least every this many bytes…
	CheckpointEvery time.Duration // …or this often
	Idle            time.Duration // give up when no bytes arrive for this long
	// OnCheckpoint is called after each fsync with the bytes on disk; an
	// error stops the transfer (e.g. errNoSpace).
	OnCheckpoint func(done int64) error
	// Progress, when set, holds the bytes written so far (live counter).
	Progress *atomic.Int64
}

var contentRange = regexp.MustCompile(`^bytes (\d+)-(\d+)/(\d+|\*)$`)

// transfer appends the rest of a file to part (resuming from its current
// size) and returns the bytes on disk. nil error means part holds exactly
// size bytes.
func transfer(ctx context.Context, open opener, part string, size int64, o transferOpts) (int64, error) {
	f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return 0, &writeError{err}
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return 0, &writeError{err}
	}
	off := st.Size()
	if off > size {
		return off, errSizeMismatch
	}
	if off == size {
		return off, nil
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	resp, err := open(ctx, off)
	if err != nil {
		return off, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusPartialContent:
		m := contentRange.FindStringSubmatch(resp.Header.Get("Content-Range"))
		if m == nil {
			return off, errors.New("bad Content-Range")
		}
		if start, _ := strconv.ParseInt(m[1], 10, 64); start != off {
			return off, errors.New("unexpected range start")
		}
		if m[3] != "*" {
			if total, _ := strconv.ParseInt(m[3], 10, 64); total != size {
				return off, errSizeMismatch
			}
		}
	case http.StatusOK:
		if resp.ContentLength >= 0 && resp.ContentLength != size {
			return off, errSizeMismatch
		}
		if off > 0 { // Range ignored: start over
			if err := f.Truncate(0); err != nil {
				return off, &writeError{err}
			}
			off = 0
		}
	case http.StatusRequestedRangeNotSatisfiable:
		// Our offset is at or past the real end: the file is smaller.
		return off, errSizeMismatch
	default:
		return off, errors.New("upstream status " + strconv.Itoa(resp.StatusCode))
	}
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return off, &writeError{err}
	}
	if o.Progress != nil {
		o.Progress.Store(off)
	}

	// Idle watchdog: armed while waiting for upstream bytes.
	var idle atomic.Bool
	timer := time.AfterFunc(o.Idle, func() { idle.Store(true); cancel() })
	defer timer.Stop()

	buf := make([]byte, 1<<20)
	lastCP, lastCPAt := off, time.Now()
	checkpoint := func() error {
		if err := f.Sync(); err != nil {
			return &writeError{err}
		}
		lastCP, lastCPAt = off, time.Now()
		if o.OnCheckpoint != nil {
			return o.OnCheckpoint(off)
		}
		return nil
	}
	for {
		timer.Reset(o.Idle)
		n, rerr := resp.Body.Read(buf)
		timer.Stop()
		if n > 0 {
			if off+int64(n) > size {
				return off, errSizeMismatch
			}
			if _, err := f.Write(buf[:n]); err != nil {
				return off, &writeError{err}
			}
			off += int64(n)
			if o.Progress != nil {
				o.Progress.Store(off)
			}
			if off-lastCP >= o.CheckpointBytes || time.Since(lastCPAt) >= o.CheckpointEvery {
				if err := checkpoint(); err != nil {
					return off, err
				}
			}
		}
		if rerr != nil {
			if err := f.Sync(); err != nil {
				return off, &writeError{err}
			}
			switch {
			case errors.Is(rerr, io.EOF) && off == size:
				return off, nil
			case errors.Is(rerr, io.EOF):
				return off, errShortRead
			case idle.Load():
				return off, errIdle
			default:
				return off, rerr
			}
		}
	}
}
