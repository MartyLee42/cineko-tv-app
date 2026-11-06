package ratings

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"time"
)

// HTTPClient builds the client for Kinopoisk traffic: no redirects (keys
// stay on the configured host), no HTTP_PROXY env, optional explicit proxy.
func HTTPClient(proxy *url.URL, timeout time.Duration) *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	if proxy != nil {
		tr.Proxy = http.ProxyURL(proxy)
	}
	tr.DialContext = (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	tr.MaxIdleConnsPerHost = 4
	return &http.Client{
		Timeout:       timeout,
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// sanitize drops the URL from transport errors: the unofficial API's
// key-status endpoint carries the key in its path.
func sanitize(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		if ue.Timeout() {
			return errors.New("kinopoisk: request timed out")
		}
		return errors.New("kinopoisk: request failed: " + ue.Err.Error())
	}
	return errors.New("kinopoisk: request failed")
}
