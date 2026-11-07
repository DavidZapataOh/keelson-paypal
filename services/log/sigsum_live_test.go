//go:build live

package main

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"sigsum.org/sigsum-go/pkg/key"
	"sigsum.org/sigsum-go/pkg/policy"
	"sigsum.org/sigsum-go/pkg/submit"
)

// sigsumVerify returns the path of the official sigsum-verify, built from the
// sigsum-go release the log uses.
func sigsumVerify(t *testing.T) string {
	t.Helper()
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(cache, "keelson-sigsum-v1.0.0")
	bin := filepath.Join(dir, "sigsum-verify")
	if _, err := os.Stat(bin); err == nil {
		return bin
	}
	cmd := exec.Command("go", "install", "sigsum.org/sigsum-go/cmd/sigsum-verify@v1.0.0")
	cmd.Dir = os.TempDir()
	cmd.Env = append(os.Environ(), "GOBIN="+dir, "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go install sigsum-verify: %v\n%s", err, out)
	}
	return bin
}

// verifyProof runs sigsum-verify on proof with msg on its standard input.
func verifyProof(t *testing.T, proof, msg []byte) error {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "checkpoint.proof")
	if err := os.WriteFile(path, proof, 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(sigsumVerify(t), "-k", "keys/sigsum-submit.pub", "-p", "policy/sigsum-seasalp.policy", path)
	cmd.Stdin = bytes.NewReader(msg)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Logf("sigsum-verify: %s", out)
	}
	return err
}

func sigsumKey(t *testing.T) string {
	t.Helper()
	k := os.Getenv("SIGSUM_SUBMIT_KEY")
	if k == "" {
		t.Fatal("SIGSUM_SUBMIT_KEY is required")
	}
	return k
}

// TestLiveCoLogBindsTheCheckpoint co-logs the deployed sandbox origin's
// checkpoint in seasalp. The proof verifies for that checkpoint body only.
func TestLiveCoLogBindsTheCheckpoint(t *testing.T) {
	signer, _, err := key.ParsePrivateKey(sigsumKey(t))
	if err != nil {
		t.Fatal(err)
	}
	p, err := policy.ReadPolicyFile("policy/sigsum-seasalp.policy")
	if err != nil {
		t.Fatal(err)
	}
	cfg := &submit.Config{Domain: sigsumDomain, RateLimitSigner: signer, Policy: p}
	base := cmp.Or(os.Getenv("LOG_URL"), "https://"+host)
	body := []byte(checkpointBody(getBody(t, base+"/"+sandbox+"/checkpoint")))
	start := time.Now()
	pr, err := CoLog(t.Context(), cfg, signer, body)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("submit → proof: %v", time.Since(start).Round(time.Millisecond))
	var b bytes.Buffer
	if err := pr.ToASCII(&b); err != nil {
		t.Fatal(err)
	}
	if err := verifyProof(t, b.Bytes(), body); err != nil {
		t.Fatalf("the proof does not verify for the checkpoint: %v", err)
	}
	forked := bytes.Clone(body)
	forked[len(forked)-3] ^= 1
	if err := verifyProof(t, b.Bytes(), forked); err == nil {
		t.Fatal("the proof verifies for a checkpoint with another root")
	}
}

func postSigsum(t *testing.T, l *testLog) (int, coLogResult) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, l.private.URL+"/"+sandbox+"/sigsum", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Error(err)
		return 0, coLogResult{}
	}
	defer res.Body.Close()
	var out coLogResult
	raw, _ := io.ReadAll(res.Body)
	_ = json.Unmarshal(raw, &out)
	return res.StatusCode, out
}

// TestLiveSigsumNowIsRateLimited fires 50 concurrent requests to co-log the
// same checkpoint: one submission starts, the rest wait, and a restarted log
// keeps waiting. The stored proof is served publicly and verifies.
func TestLiveSigsumNowIsRateLimited(t *testing.T) {
	db, dbURL := testDB(t)
	keys := newTestKeys(t)
	keys.env["SIGSUM_SUBMIT_KEY"] = sigsumKey(t)
	policyFile, err := os.ReadFile("policy/sigsum-seasalp.policy")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(keys.policyDir, "sigsum-seasalp.policy"), policyFile, 0o644); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	l := startLog(t, keys, dir, db, dbURL)

	var wg sync.WaitGroup
	var mu sync.Mutex
	statuses := map[int]int{}
	var size int64
	for range 50 {
		wg.Go(func() {
			status, res := postSigsum(t, l)
			mu.Lock()
			defer mu.Unlock()
			statuses[status]++
			if status == http.StatusAccepted {
				size = res.Size
			}
			if status == http.StatusTooManyRequests && res.RetryAfter <= 0 {
				t.Errorf("429 without retryAfter: %+v", res)
			}
		})
	}
	wg.Wait()
	if statuses[http.StatusAccepted] != 1 || statuses[http.StatusTooManyRequests] != 49 || l.s.colog.submissions != 1 {
		t.Fatalf("statuses %v, %d submissions", statuses, l.s.colog.submissions)
	}

	// A restarted co-logger reads the rate from the same directory.
	restarted, err := newCoLogger(l.s.colog.cfg, l.s.colog.signer, dir, l.s.log)
	if err != nil {
		t.Fatal(err)
	}
	if res, _, err := restarted.now(t.Context(), l.origin(sandbox)); !errors.Is(err, errTooSoon) || res.RetryAfter <= 0 {
		t.Fatalf("after a restart: %v %+v", err, res)
	}

	name := sandbox + "/sigsum/" + strconv.FormatInt(size, 10)
	start := time.Now()
	for {
		res, proof := getPublic(t, l, name+".proof")
		if res.StatusCode == http.StatusOK {
			t.Logf("submit → proof: %v", time.Since(start).Round(time.Millisecond))
			_, msg := getPublic(t, l, name+".msg")
			if err := verifyProof(t, proof, msg); err != nil {
				t.Fatal(err)
			}
			if status, res := postSigsum(t, l); status != http.StatusOK || res.Proof != string(proof) {
				t.Fatalf("a co-logged checkpoint: %d %+v", status, res)
			}
			return
		}
		if time.Since(start) > submit.DefaultTimeout {
			t.Fatal("no proof")
		}
		time.Sleep(time.Second)
	}
}
