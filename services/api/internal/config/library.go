package config

import (
	"errors"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
)

// LibraryConfig drives server downloads (internal/downloads).
type LibraryConfig struct {
	// Dir holds downloaded files (<dir>/<info hash>/<file index>[.ext]).
	Dir string
	// MaxJobs is how many downloads read from TorrServer at once.
	MaxJobs int
	// InternalURL is how the transcoder reaches this API (compat streams of
	// downloaded files read the API's own stream endpoint).
	InternalURL string
}

func loadLibrary(get func(string, string) string, errs *[]error) LibraryConfig {
	l := LibraryConfig{
		Dir:         filepath.Clean(get("LIBRARY_DIR", "/var/lib/martytv/library")),
		MaxJobs:     2,
		InternalURL: strings.TrimRight(get("INTERNAL_API_URL", "http://api:8080"), "/"),
	}
	if !filepath.IsAbs(l.Dir) {
		*errs = append(*errs, errors.New("LIBRARY_DIR must be an absolute path"))
	}
	if v := get("DOWNLOAD_MAX_JOBS", ""); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 8 {
			*errs = append(*errs, errors.New("DOWNLOAD_MAX_JOBS must be 1…8"))
		} else {
			l.MaxJobs = n
		}
	}
	if u, err := url.Parse(l.InternalURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		*errs = append(*errs, errors.New("INTERNAL_API_URL must be an absolute http(s) URL"))
	}
	return l
}
