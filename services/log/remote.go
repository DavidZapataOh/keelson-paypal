package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/transparency-dev/tessera/client"
	"golang.org/x/mod/sumdb/note"
)

// remoteTimeout bounds one signing round trip to leg A.
const remoteTimeout = 3 * time.Second

// remoteSigner is a note.Signer whose Ed25519 key lives in leg A, the TDX leg.
// Leg A signs a checkpoint only if it extends the last one it signed for the
// origin, so each request carries the consistency proof from that size, built
// from the log's own tiles.
//
// The connection is RA-TLS: leg A's certificate carries its dstack attestation,
// and its attested signer signs the certificate's hash (GET /v1/log/tls). The
// signer must be an active TDX signer the API admitted from a verified
// attestation, so the log talks to that CVM and no other.
type remoteSigner struct {
	name     string
	hash     uint32
	public   ed25519.PublicKey
	url      string
	token    string
	registry signerRegistry

	mu       sync.Mutex
	reader   client.TileFetcherFunc
	last     *uint64
	pinned   atomic.Pointer[[32]byte]
	http     *http.Client
	bindOnce sync.Mutex
}

func newRemoteSigner(vkey, url, token string, registry signerRegistry) (*remoteSigner, error) {
	v, err := note.NewVerifier(vkey)
	if err != nil {
		return nil, fmt.Errorf("remote signer vkey: %w", err)
	}
	parts := strings.SplitN(vkey, "+", 3)
	key, err := base64.StdEncoding.DecodeString(parts[len(parts)-1])
	if len(parts) != 3 || err != nil || len(key) != 33 || key[0] != 1 {
		return nil, errors.New("remote signer vkey is not an Ed25519 note key")
	}
	s := &remoteSigner{
		name:     v.Name(),
		hash:     v.KeyHash(),
		public:   ed25519.PublicKey(key[1:]),
		url:      strings.TrimSuffix(url, "/"),
		token:    token,
		registry: registry,
	}
	s.http = &http.Client{
		Timeout: remoteTimeout,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			// The certificate is authenticated by its binding to leg A's attested
			// signer, not by a CA: only the bound certificate is accepted.
			InsecureSkipVerify: true,
			VerifyConnection: func(cs tls.ConnectionState) error {
				pinned := s.pinned.Load()
				if pinned == nil || len(cs.PeerCertificates) == 0 || sha256.Sum256(cs.PeerCertificates[0].Raw) != *pinned {
					return errors.New("leg A's certificate is not the one its signer bound")
				}
				return nil
			},
		}},
	}
	return s, nil
}

// setReader gives the signer the log's tiles once its appender is open.
func (s *remoteSigner) setReader(read client.TileFetcherFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reader = read
}

func (s *remoteSigner) Name() string    { return s.name }
func (s *remoteSigner) KeyHash() uint32 { return s.hash }

// Sign asks leg A to sign the checkpoint body msg.
func (s *remoteSigner) Sign(msg []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*remoteTimeout)
	defer cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	size, err := checkpointSize(msg)
	if err != nil {
		return nil, err
	}
	sig, latest, err := s.sign(ctx, msg, size, s.last)
	if errors.Is(err, errNotExtending) && latest != nil && (s.last == nil || *latest != *s.last) {
		// Leg A signed a later size than the log remembers, as after a restart.
		sig, _, err = s.sign(ctx, msg, size, latest)
	}
	if err != nil {
		return nil, err
	}
	s.last = &size
	return sig, nil
}

var errNotExtending = errors.New("leg A refused a checkpoint that does not extend its last one")

func (s *remoteSigner) sign(ctx context.Context, msg []byte, size uint64, from *uint64) ([]byte, *uint64, error) {
	body := map[string]any{"checkpoint": string(msg)}
	if from != nil {
		body["from_size"] = *from
		if *from < size {
			if s.reader == nil {
				return nil, nil, errors.New("the log's tiles are not open yet")
			}
			pb, err := client.NewProofBuilder(ctx, size, s.reader)
			if err != nil {
				return nil, nil, err
			}
			proof, err := pb.ConsistencyProof(ctx, *from, size)
			if err != nil {
				return nil, nil, err
			}
			hashes := make([]string, len(proof))
			for i, h := range proof {
				hashes[i] = base64.StdEncoding.EncodeToString(h)
			}
			body["consistency"] = hashes
		}
	}
	raw, _ := json.Marshal(body)
	res, err := s.do(ctx, http.MethodPost, "/v1/log/sign", raw)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	out, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return nil, nil, err
	}
	if res.StatusCode == http.StatusConflict {
		var p struct {
			Latest *uint64 `json:"latest"`
		}
		_ = json.Unmarshal(out, &p)
		return nil, p.Latest, errNotExtending
	}
	if res.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("leg A answered %d to a checkpoint signature", res.StatusCode)
	}
	var signed struct {
		Signature string `json:"signature"`
		Vkey      string `json:"vkey"`
	}
	if err := json.Unmarshal(out, &signed); err != nil {
		return nil, nil, err
	}
	sig, err := base64.StdEncoding.DecodeString(signed.Signature)
	if err != nil || !ed25519.Verify(s.public, msg, sig) {
		return nil, nil, errors.New("leg A's signature does not verify under the pinned log key")
	}
	return sig, nil, nil
}

// do sends a bearer request over the bound RA-TLS connection, binding it first
// or again when leg A's certificate changed.
func (s *remoteSigner) do(ctx context.Context, method, path string, body []byte) (*http.Response, error) {
	if s.pinned.Load() == nil {
		if err := s.bind(ctx); err != nil {
			return nil, err
		}
	}
	send := func() (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, method, s.url+path, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+s.token)
		req.Header.Set("Content-Type", "application/json")
		return s.http.Do(req)
	}
	res, err := send()
	if err != nil {
		// A restarted leg has a new certificate: bind it, then retry once.
		if berr := s.bind(ctx); berr != nil {
			return nil, errors.Join(err, berr)
		}
		return send()
	}
	return res, nil
}

// bind reads leg A's certificate binding and pins the certificate once its
// signer is an active TDX signer.
func (s *remoteSigner) bind(ctx context.Context) error {
	s.bindOnce.Lock()
	defer s.bindOnce.Unlock()
	probe := &http.Client{Timeout: remoteTimeout, Transport: &http.Transport{
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true},
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url+"/v1/log/tls", nil)
	if err != nil {
		return err
	}
	res, err := probe.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.TLS == nil || len(res.TLS.PeerCertificates) == 0 || res.StatusCode != http.StatusOK {
		return errors.New("leg A serves no certificate binding")
	}
	var b struct {
		CertificateSHA256 string `json:"certificate_sha256"`
		Signature         string `json:"signature"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<10)).Decode(&b); err != nil {
		return err
	}
	cert := sha256.Sum256(res.TLS.PeerCertificates[0].Raw)
	stated, err := hex.DecodeString(strings.TrimPrefix(b.CertificateSHA256, "0x"))
	if err != nil || !bytes.Equal(stated, cert[:]) {
		return errors.New("leg A's binding names another certificate")
	}
	signer, err := recoverBinding(cert, b.Signature)
	if err != nil {
		return err
	}
	if _, ok, err := s.registry.Active(ctx, teeTDX, signer, time.Now()); err != nil {
		return err
	} else if !ok {
		return fmt.Errorf("leg A's certificate is bound by %x, not an active TDX signer", signer)
	}
	s.pinned.Store(&cert)
	return nil
}

// recoverBinding recovers the signer of keccak256("keelson/ra-tls/v1" ‖ cert).
func recoverBinding(cert [32]byte, signature string) ([20]byte, error) {
	sig, err := hex.DecodeString(strings.TrimPrefix(signature, "0x"))
	if err != nil || len(sig) != 65 || sig[64] < 27 {
		return [20]byte{}, errors.New("malformed binding signature")
	}
	sig[64] -= 27
	digest := crypto.Keccak256(append([]byte("keelson/ra-tls/v1"), cert[:]...))
	pub, err := crypto.SigToPub(digest, sig)
	if err != nil {
		return [20]byte{}, err
	}
	return crypto.PubkeyToAddress(*pub), nil
}

// checkpointSize reads the size line of a checkpoint body.
func checkpointSize(msg []byte) (uint64, error) {
	lines := strings.SplitN(string(msg), "\n", 3)
	if len(lines) < 3 {
		return 0, errors.New("not a checkpoint body")
	}
	return strconv.ParseUint(lines[1], 10, 64)
}
