package main

import (
	"net/http"
	"time"
)

// maxResponseBytes bounds any response from the log: a full entry bundle of
// 256 leaves of at most 1 KiB is about 260 KiB, a checkpoint a few KiB.
const maxResponseBytes = 1 << 20

// newLogClient is the HTTP client the monitor reads the log and Sigsum with.
// A larger response fails instead of exhausting memory.
func newLogClient() *http.Client {
	return &http.Client{Timeout: 10 * time.Second, Transport: limitedTransport{http.DefaultTransport, maxResponseBytes}}
}

type limitedTransport struct {
	rt    http.RoundTripper
	limit int64
}

func (t limitedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	res, err := t.rt.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	res.Body = http.MaxBytesReader(nil, res.Body, t.limit)
	return res, nil
}
