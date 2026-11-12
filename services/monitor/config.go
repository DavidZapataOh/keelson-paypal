package main

import (
	"cmp"
	"embed"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"filippo.io/torchwood"
	"github.com/DavidZapataOh/keelson-paypal/internal/conformance"
	"golang.org/x/mod/sumdb/note"
	sigsumcrypto "sigsum.org/sigsum-go/pkg/crypto"
	"sigsum.org/sigsum-go/pkg/key"
	"sigsum.org/sigsum-go/pkg/policy"
)

// The policies and keys the monitor checks against are pinned in its binary,
// never fetched from the log.
//
//go:embed policy
var pinned embed.FS

// pollInterval is the log's checkpoint interval: a fork served to the monitor
// is seen within one interval.
const pollInterval = 500 * time.Millisecond

// origin is one log the monitor checks.
type origin struct {
	Name string
	// URL is the origin's c2sp.org/tlog-tiles prefix, ending in a slash. It
	// is nil for an origin known only through gossip.
	URL *url.URL
	// PolicyText is the witness policy as pinned.
	PolicyText []byte
	// Policy requires the log's signatures and the witness quorum.
	Policy torchwood.Policy
	// LogPolicy requires only the log's signatures.
	LogPolicy torchwood.Policy
	// Verifier is the log's Ed25519 key.
	Verifier note.Verifier
	// Retired are the Ed25519 keys the log signed with before Verifier.
	Retired []RetiredKey
	// Chain is where the origin anchors, or nil for an origin the monitor
	// checks against no chain.
	Chain *chainTrust
}

// RetiredKey is a key an origin signed with until its tree reached UntilSize
// leaves. A view saved under it is still followed; a checkpoint it signs for
// a larger tree proves nothing.
type RetiredKey struct {
	Verifier  note.Verifier
	UntilSize uint64
}

// cutoverPending is the size of a move whose cutover is not known yet, as
// @keelson/log's CUTOVER_PENDING: the retired key still covers every size, and
// a test refuses to ship it.
const cutoverPending = ^uint64(0)

// retiredKeys are the keys each origin moved from, with the size it had
// reached when it moved, as in @keelson/log's LOG_VKEY_HISTORY.
var retiredKeys = map[string][]struct {
	vkey      string
	untilSize uint64
}{
	"log.keelson.finance/alibi/2026-1": {
		{"log.keelson.finance/alibi/2026-1+2e11a7ea+AfBrbrDNyb9uyXNtg3PXXnVxKQBcMGqa1OlCtxlttUBX", 796},
		{"log.keelson.finance/alibi/2026-1+8553fcbd+ATEHrhTfdzkwLLgf9SZhMsIhsHzRmvpFnaBfgK0D10Id", cutoverPending},
	},
	"log.keelson.finance/alibi-live/2026-1": {
		{"log.keelson.finance/alibi-live/2026-1+2cbeb917+AUYYGFiA5vhiLgoStIMQMZCqkg5QPBseIXyURpLLwvph", 0},
		{"log.keelson.finance/alibi-live/2026-1+39e7ebfa+AUiaY8TAW9gFbueTv6mPbHeZq5ClgTnG9a4kGEnU5uyL", cutoverPending},
	},
}

type config struct {
	DataDir string
	Addr    string
	Poll    time.Duration
	// ClientIPHeader is the header the proxy in front sets to the client's
	// address, such as X-Real-IP on Railway. Empty means no proxy.
	ClientIPHeader string
	// Origins are followed; Conformance is known only through gossip.
	Origins     []*origin
	Conformance *origin
	// Sigsum is how the log's co-logged checkpoints are verified.
	Sigsum *sigsumTrust
}

// sigsumTrust is the Sigsum policy and the submit key the log co-logs with.
type sigsumTrust struct {
	Policy     *policy.Policy
	SubmitKeys map[sigsumcrypto.Hash]sigsumcrypto.PublicKey
}

func loadConfig(getenv func(string) string) (*config, error) {
	c := &config{
		DataDir: getenv("MONITOR_DATA_DIR"),
		Addr:    ":" + cmp.Or(getenv("PORT"), "8080"),
		Poll:    pollInterval,

		ClientIPHeader: getenv("MONITOR_CLIENT_IP_HEADER"),
	}
	if c.DataDir == "" {
		return nil, errors.New("MONITOR_DATA_DIR is required")
	}
	logURL := strings.TrimSuffix(cmp.Or(getenv("LOG_URL"), "https://"+logHost), "/")
	chains := map[string]*chainTrust{
		"alibi/2026-1":      arbitrumSepolia(getenv),
		"alibi-live/2026-1": arbitrumOne,
	}
	for _, path := range []string{"alibi/2026-1", "alibi-live/2026-1"} {
		o, err := pinnedOrigin(logHost+"/"+path, logURL+"/"+path+"/")
		if err != nil {
			return nil, err
		}
		o.Chain = chains[path]
		c.Origins = append(c.Origins, o)
	}
	var err error
	if c.Conformance, err = pinnedOrigin(conformance.Origin, ""); err != nil {
		return nil, err
	}
	if c.Sigsum, err = pinnedSigsum(); err != nil {
		return nil, err
	}
	return c, nil
}

// logHost is the name every Keelson origin starts with.
const logHost = "log.keelson.finance"

func pinnedOrigin(name, logURL string) (*origin, error) {
	file := strings.ReplaceAll(strings.TrimPrefix(name, logHost+"/"), "/", "-") + ".policy"
	p, err := pinned.ReadFile("policy/" + file)
	if err != nil {
		return nil, err
	}
	return newOrigin(name, logURL, p)
}

func pinnedSigsum() (*sigsumTrust, error) {
	p, err := pinned.ReadFile("policy/sigsum-seasalp.policy")
	if err != nil {
		return nil, err
	}
	sp, err := policy.ParseConfig(strings.NewReader(string(p)))
	if err != nil {
		return nil, fmt.Errorf("sigsum policy: %w", err)
	}
	k, err := pinned.ReadFile("policy/sigsum-submit.pub")
	if err != nil {
		return nil, err
	}
	keys, err := key.ParsePublicKeys(strings.NewReader(string(k)))
	if err != nil {
		return nil, fmt.Errorf("sigsum submit key: %w", err)
	}
	return &sigsumTrust{Policy: sp, SubmitKeys: keys}, nil
}

// newOrigin parses a witness policy (c2sp.org/tlog-witness, Sigsum policy
// format). Its log lines are the origin's keys, one of which must be Ed25519.
func newOrigin(name, logURL string, policyText []byte) (*origin, error) {
	o := &origin{Name: name, PolicyText: policyText}
	if logURL != "" {
		u, err := url.Parse(logURL)
		if err != nil || !strings.HasSuffix(u.Path, "/") {
			return nil, fmt.Errorf("%s: bad log URL %q", name, logURL)
		}
		o.URL = u
	}
	var err error
	if o.Policy, err = torchwood.ParsePolicy(policyText); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	var logs strings.Builder
	for line := range strings.Lines(string(policyText)) {
		line, _, _ = strings.Cut(line, "#")
		f := strings.Fields(line)
		if len(f) < 2 || f[0] != "log" {
			continue
		}
		logs.WriteString("log " + f[1] + "\n")
		if v, err := note.NewVerifier(f[1]); err == nil {
			if v.Name() != name {
				return nil, fmt.Errorf("%s: log key is for %q", name, v.Name())
			}
			o.Verifier = v
		}
	}
	if o.Verifier == nil {
		return nil, fmt.Errorf("%s: the policy has no Ed25519 log key", name)
	}
	for _, r := range retiredKeys[name] {
		v, err := note.NewVerifier(r.vkey)
		if err != nil {
			return nil, fmt.Errorf("%s: retired key: %w", name, err)
		}
		o.Retired = append(o.Retired, RetiredKey{Verifier: v, UntilSize: r.untilSize})
	}
	if o.LogPolicy, err = torchwood.ParsePolicy([]byte(logs.String() + "quorum none\n")); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	return o, nil
}
