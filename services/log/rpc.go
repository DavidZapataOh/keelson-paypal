package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
)

// publicRPC is each chain's public RPC, rate-limited per IP, which serves
// when the configured provider does not.
var publicRPC = map[uint64]string{
	421614: "https://sepolia-rollup.arbitrum.io/rpc",
	42161:  "https://arb1.arbitrum.io/rpc",
}

// rpcAttemptTimeout bounds every endpoint but the last, so one that hangs
// falls through to the next.
var rpcAttemptTimeout = 10 * time.Second

// fallbackTransport sends each JSON-RPC request to the first endpoint and,
// on a rate limit, a server error, a transport error or a timeout, to the
// next one. The last endpoint's answer is returned as is.
type fallbackTransport struct {
	urls    []*url.URL
	next    http.RoundTripper
	timeout time.Duration
}

func (t *fallbackTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil {
		var err error
		body, err = io.ReadAll(req.Body)
		req.Body.Close()
		if err != nil {
			return nil, err
		}
	}
	for i, u := range t.urls {
		last := i == len(t.urls)-1
		ctx, cancel := req.Context(), context.CancelFunc(func() {})
		if !last {
			ctx, cancel = context.WithTimeout(ctx, t.timeout)
		}
		r := req.Clone(ctx)
		r.URL, r.Host = u, u.Host
		r.Body, r.ContentLength = io.NopCloser(bytes.NewReader(body)), int64(len(body))
		r.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
		resp, err := t.next.RoundTrip(r)
		if last || (err == nil && resp.StatusCode != http.StatusTooManyRequests && resp.StatusCode < 500) {
			if err != nil {
				cancel()
				return nil, err
			}
			resp.Body = cancelOnClose{resp.Body, cancel}
			return resp, nil
		}
		if err == nil {
			resp.Body.Close()
		}
		cancel()
		if req.Context().Err() != nil {
			return nil, req.Context().Err()
		}
	}
	return nil, errors.New("no RPC endpoint")
}

// cancelOnClose releases an attempt's timeout once its body is read.
type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c cancelOnClose) Close() error {
	defer c.cancel()
	return c.ReadCloser.Close()
}

// dialRPC connects to the first of urls, falling back to the others in order.
func dialRPC(ctx context.Context, urls []string) (*ethclient.Client, error) {
	if len(urls) == 0 {
		return nil, errors.New("no RPC endpoint")
	}
	parsed := make([]*url.URL, len(urls))
	for i, raw := range urls {
		u, err := url.Parse(raw)
		if err != nil {
			// The error would quote the URL, which carries the provider's API key.
			return nil, errors.New("RPC endpoint is not a URL")
		}
		parsed[i] = u
	}
	hc := &http.Client{Transport: &fallbackTransport{urls: parsed, next: http.DefaultTransport, timeout: rpcAttemptTimeout}}
	c, err := rpc.DialOptions(ctx, urls[0], rpc.WithHTTPClient(hc))
	if err != nil {
		return nil, chainError("dial", err)
	}
	return ethclient.NewClient(c), nil
}
