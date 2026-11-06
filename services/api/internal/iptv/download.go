package iptv

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// Large guides (iptvx.one 18–85 MB, epgshare01 ALL_SOURCES 200 MB) are
// downloaded to a temp file first and parsed from disk afterwards, so a
// slow parse never stalls the network read (a stalled SOCKS tunnel used to
// cut the stream mid-way and surface as a parse error). The download has an
// overall deadline, an idle (stall) timeout, verifies Content-Length and
// resumes with Range after an interruption when the server supports it.

type downloadOpts struct {
	Total    time.Duration // overall deadline (all attempts and paths)
	Idle     time.Duration // no byte for this long = stalled
	MaxBytes int64
	Resumes  int // extra attempts after an interruption, per path
	Headers  map[string]string
	// Progress is called with bytes so far and the total (−1 = unknown).
	Progress func(got, total int64)
}

func defaultDownloadOpts() downloadOpts {
	return downloadOpts{Total: 15 * time.Minute, Idle: 90 * time.Second, MaxBytes: 1 << 30, Resumes: 4}
}

// downloadError is a classified failure: Code is download_timeout,
// truncated, http_status, too_large or fetch_failed.
type downloadError struct {
	Code   string
	Detail string
	Status int
}

func (e *downloadError) Error() string {
	if e.Detail == "" {
		return e.Code
	}
	return e.Code + ": " + e.Detail
}

func mb(n int64) string { return strconv.FormatFloat(float64(n)/1e6, 'f', 1, 64) + " MB" }

// downloadTo fetches u into path (created/truncated). viaProxy picks the
// proxy first; the other path (when configured) is the fallback. Returns
// the path used ("direct"/"proxy") and the byte count.
func (f *fetcher) downloadTo(ctx context.Context, u string, viaProxy bool, path string, o downloadOpts) (string, int64, error) {
	ctx, cancel := context.WithTimeout(ctx, o.Total)
	defer cancel()
	type route struct {
		name string
		hc   *http.Client
	}
	var routes []route
	if viaProxy && f.proxy != nil {
		routes = append(routes, route{"proxy", f.proxy})
	}
	routes = append(routes, route{"direct", f.direct})
	if !viaProxy && f.proxy != nil {
		routes = append(routes, route{"proxy", f.proxy})
	}
	var errs []string
	var last error
	for _, r := range routes {
		n, err := downloadVia(ctx, r.hc, u, path, o)
		if err == nil {
			return r.name, n, nil
		}
		last = err
		errs = append(errs, r.name+": "+err.Error())
		var de *downloadError
		if ctx.Err() != nil || (errors.As(err, &de) && de.Status == http.StatusNotFound) {
			break // out of time, or the file doesn't exist anywhere
		}
	}
	if len(errs) > 1 {
		var de *downloadError
		code := "fetch_failed"
		if errors.As(last, &de) {
			code = de.Code
		}
		return "", 0, &downloadError{Code: code, Detail: strings.Join(errs, "; ")}
	}
	return "", 0, last
}

// downloadVia runs the attempts over one client.
func downloadVia(ctx context.Context, hc *http.Client, u, path string, o downloadOpts) (int64, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o600)
	if err != nil {
		return 0, &downloadError{Code: "fetch_failed", Detail: "temp file: " + err.Error()}
	}
	defer file.Close()
	var (
		got       int64
		total     int64  = -1
		validator string // ETag / Last-Modified for If-Range
		ranges    bool
		lastErr   error
		connFails int
	)
	started := time.Now()
	for attempt := 0; attempt <= o.Resumes && ctx.Err() == nil; attempt++ {
		if attempt > 0 {
			if !ranges && got > 0 { // can't resume: start over
				if err := resetFile(file); err != nil {
					return 0, err
				}
				got = 0
			}
			select { // short back-off between attempts
			case <-ctx.Done():
				continue
			case <-time.After(time.Duration(attempt) * time.Second):
			}
		}
		r := downloadAttempt(ctx, hc, u, file, got, validator, o)
		if r.reset {
			got = 0
		}
		got += r.n
		if r.total >= 0 {
			total = r.total
		}
		ranges = ranges || r.ranges
		if r.validator != "" {
			validator = r.validator
		}
		if r.err == nil {
			if total >= 0 && got < total {
				lastErr = &downloadError{Code: "truncated", Detail: fmt.Sprintf("got %s of %s", mb(got), mb(total))}
				continue
			}
			return got, nil
		}
		lastErr = r.err
		var de *downloadError
		if errors.As(r.err, &de) && (de.Code == "too_large" || (de.Status >= 400 && de.Status < 500 && de.Status != 408 && de.Status != 429)) {
			return got, r.err // permanent
		}
		// Can't connect at all (refused, DNS, blocked address): one retry,
		// then let the caller try the other path.
		if errors.As(r.err, &de) && de.Code == "fetch_failed" && r.n == 0 {
			if connFails++; connFails >= 2 || de.Detail == "address not allowed" {
				return got, r.err
			}
		}
	}
	if ctx.Err() != nil {
		detail := "after " + time.Since(started).Round(time.Second).String() + ", " + mb(got)
		if total > 0 {
			detail += " of " + mb(total)
		}
		return got, &downloadError{Code: "download_timeout", Detail: detail}
	}
	if lastErr == nil {
		lastErr = &downloadError{Code: "fetch_failed"}
	}
	return got, lastErr
}

func resetFile(f *os.File) error {
	if err := f.Truncate(0); err != nil {
		return &downloadError{Code: "fetch_failed", Detail: err.Error()}
	}
	_, err := f.Seek(0, io.SeekStart)
	return err
}

type attemptResult struct {
	n         int64 // bytes written by this attempt
	reset     bool  // the file was restarted from 0 (range ignored)
	total     int64 // full size when known, else −1
	ranges    bool  // the server supports Range
	validator string
	err       error
}

// downloadAttempt GETs (from offset when > 0) and appends to file.
func downloadAttempt(ctx context.Context, hc *http.Client, u string, file *os.File, offset int64, validator string, o downloadOpts) attemptResult {
	res := attemptResult{total: -1}
	actx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(actx, http.MethodGet, u, nil)
	if err != nil {
		res.err = &downloadError{Code: "fetch_failed", Detail: "invalid url"}
		return res
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Cineko IPTV)")
	// Raw bytes: a transparent gzip decode would break Range offsets.
	req.Header.Set("Accept-Encoding", "identity")
	for k, v := range o.Headers {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
	if offset > 0 {
		req.Header.Set("Range", "bytes="+strconv.FormatInt(offset, 10)+"-")
		if validator != "" {
			req.Header.Set("If-Range", validator)
		}
	}
	resp, err := hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			res.err = ctx.Err()
		} else {
			res.err = &downloadError{Code: "fetch_failed", Detail: sanitizeErr(err)}
		}
		return res
	}
	defer resp.Body.Close()
	res.ranges = strings.EqualFold(resp.Header.Get("Accept-Ranges"), "bytes") || resp.StatusCode == http.StatusPartialContent
	if res.validator = resp.Header.Get("ETag"); res.validator == "" {
		res.validator = resp.Header.Get("Last-Modified")
	}
	start := offset
	switch resp.StatusCode {
	case http.StatusOK:
		if offset > 0 { // range ignored (or the file changed): start over
			if err := resetFile(file); err != nil {
				res.err = err
				return res
			}
			res.reset, start = true, 0
		}
		if resp.ContentLength >= 0 {
			res.total = resp.ContentLength
		}
	case http.StatusPartialContent:
		s, size, ok := parseContentRange(resp.Header.Get("Content-Range"))
		if !ok || s != offset {
			res.err = &downloadError{Code: "fetch_failed", Detail: "bad Content-Range"}
			return res
		}
		res.total = size
	case http.StatusRequestedRangeNotSatisfiable:
		if _, size, ok := parseContentRange(resp.Header.Get("Content-Range")); ok && size == offset {
			res.total = size // already complete
			return res
		}
		res.err = &downloadError{Code: "fetch_failed", Detail: "range not satisfiable", Status: resp.StatusCode}
		return res
	default:
		res.err = &downloadError{Code: "http_status", Detail: "HTTP " + strconv.Itoa(resp.StatusCode), Status: resp.StatusCode}
		return res
	}
	if res.total > o.MaxBytes {
		res.err = &downloadError{Code: "too_large", Detail: mb(res.total)}
		return res
	}
	res.n, res.err = copyIdle(actx, cancel, resp.Body, file, start, res.total, o)
	return res
}

// copyIdle copies body to file; a read waiting longer than o.Idle cancels
// the attempt (stalled).
func copyIdle(ctx context.Context, cancel context.CancelFunc, body io.Reader, file *os.File, offset, total int64, o downloadOpts) (int64, error) {
	var stalled atomic.Bool
	timer := time.AfterFunc(o.Idle, func() { stalled.Store(true); cancel() })
	defer timer.Stop()
	buf := make([]byte, 256<<10)
	var n, lastReport int64
	for {
		k, err := body.Read(buf)
		if k > 0 {
			timer.Reset(o.Idle)
			if offset+n+int64(k) > o.MaxBytes {
				return n, &downloadError{Code: "too_large", Detail: "over " + mb(o.MaxBytes)}
			}
			if _, werr := file.Write(buf[:k]); werr != nil {
				return n, &downloadError{Code: "fetch_failed", Detail: "write: " + werr.Error()}
			}
			n += int64(k)
			if o.Progress != nil && n-lastReport >= 1<<20 {
				o.Progress(offset+n, total)
				lastReport = n
			}
		}
		if err == io.EOF {
			if o.Progress != nil {
				o.Progress(offset+n, total)
			}
			return n, nil
		}
		if err != nil {
			switch {
			case stalled.Load():
				return n, &downloadError{Code: "stalled", Detail: "no data for " + o.Idle.String() + " at " + mb(offset+n)}
			case ctx.Err() != nil:
				return n, ctx.Err()
			}
			return n, &downloadError{Code: "truncated", Detail: "connection lost at " + mb(offset+n) + " (" + sanitizeErr(err) + ")"}
		}
	}
}

// parseContentRange reads "bytes start-end/size" (size may be "*").
func parseContentRange(v string) (start, size int64, ok bool) {
	v = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(v), "bytes"))
	rng, sz, found := strings.Cut(v, "/")
	if !found {
		return 0, 0, false
	}
	size = -1
	if sz != "*" {
		n, err := strconv.ParseInt(sz, 10, 64)
		if err != nil {
			return 0, 0, false
		}
		size = n
	}
	if rng == "*" {
		return 0, size, true
	}
	a, _, found := strings.Cut(rng, "-")
	if !found {
		return 0, 0, false
	}
	s, err := strconv.ParseInt(strings.TrimSpace(a), 10, 64)
	if err != nil {
		return 0, 0, false
	}
	return s, size, true
}
