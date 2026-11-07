package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"filippo.io/torchwood"
	"github.com/DavidZapataOh/keelson-paypal/internal/conformance"
	"golang.org/x/crypto/ssh"
	"golang.org/x/mod/sumdb/note"
)

// litewitnessVersion is the torchwood release the witness image is built from.
const litewitnessVersion = "v0.10.0"

// litewitnessBin returns a directory holding litewitness and witnessctl built
// from the pinned torchwood release.
func litewitnessBin(t testing.TB) string {
	t.Helper()
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(cache, "keelson-litewitness-"+litewitnessVersion)
	if _, err := os.Stat(filepath.Join(dir, "witnessctl")); err == nil {
		return dir
	}
	cmd := exec.Command("go", "install",
		"filippo.io/torchwood/cmd/litewitness@"+litewitnessVersion,
		"filippo.io/torchwood/cmd/witnessctl@"+litewitnessVersion)
	cmd.Dir = os.TempDir()
	cmd.Env = append(os.Environ(), "GOBIN="+dir, "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go install litewitness: %v\n%s", err, out)
	}
	return dir
}

// testWitness is litewitness started by the image's entrypoint.
type testWitness struct {
	name string
	url  string
	vkey string
	cmd  *exec.Cmd
}

// startWitness runs services/witness/entrypoint.sh with a fresh key, cosigning
// the logs in logs (origin → log vkey).
func startWitness(t testing.TB, name string, logs map[string]string) *testWitness {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	signer, err := torchwood.NewCosignatureSigner(name, priv)
	if err != nil {
		t.Fatal(err)
	}
	// A short directory: ssh-agent sockets are limited to 104 bytes on macOS.
	dir, err := os.MkdirTemp("", "lw")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	var pairs []string
	for origin, vkey := range logs {
		pairs = append(pairs, origin+"="+vkey)
	}
	port := freePort(t)
	cmd := exec.Command("sh", "../witness/entrypoint.sh")
	cmd.Env = []string{
		"PATH=" + litewitnessBin(t) + ":" + os.Getenv("PATH"),
		"HOME=" + dir,
		"WITNESS_NAME=" + name,
		"WITNESS_KEY=" + string(pem.EncodeToMemory(block)),
		"WITNESS_LOGS=" + strings.Join(pairs, ";"),
		"DB=" + filepath.Join(dir, "litewitness.db"),
		"PORT=" + strconv.Itoa(port),
		"LITEWITNESS_SOCK=" + filepath.Join(dir, "agent.sock"),
	}
	// The witness and its ssh-agent share a process group, stopped together.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	w := &testWitness{name: name, url: fmt.Sprintf("http://127.0.0.1:%d", port), vkey: signer.Verifier().String(), cmd: cmd}
	t.Cleanup(w.stop)
	deadline := time.Now().Add(10 * time.Second)
	for {
		res, err := http.Get(w.url + "/")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return w
			}
		}
		if time.Now().After(deadline) {
			w.stop()
			t.Fatalf("%s did not start: %s", name, stderr.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (w *testWitness) stop() {
	if w.cmd.Process != nil {
		_ = syscall.Kill(-w.cmd.Process.Pid, syscall.SIGKILL)
		_ = w.cmd.Wait()
	}
}

func freePort(t testing.TB) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// witnessPolicy is the policy of origin with its log keys and the witnesses,
// two of which must cosign.
func witnessPolicy(logVkeys []string, ws []*testWitness) string {
	var b strings.Builder
	for _, v := range logVkeys {
		fmt.Fprintf(&b, "log %s\n", v)
	}
	var names []string
	for i, w := range ws {
		fmt.Fprintf(&b, "witness w%d %s %s\n", i+1, w.vkey, w.url)
		names = append(names, fmt.Sprintf("w%d", i+1))
	}
	fmt.Fprintf(&b, "group own 2 %s\nquorum own\n", strings.Join(names, " "))
	return b.String()
}

// cosigners returns the witnesses whose cosignature on cp verifies, with the
// time each one cosigned.
func cosigners(t testing.TB, cp []byte, ws []*testWitness) map[string]time.Time {
	t.Helper()
	out := map[string]time.Time{}
	for _, w := range ws {
		v, err := torchwood.NewCosignatureVerifier(w.vkey)
		if err != nil {
			t.Fatal(err)
		}
		n, err := note.Open(cp, note.VerifierList(v))
		if err != nil {
			continue
		}
		ts, err := torchwood.CosignatureTimestamp(n.Sigs[0])
		if err != nil {
			t.Fatal(err)
		}
		out[w.name] = time.Unix(ts, 0)
	}
	return out
}

// addCheckpoint posts a c2sp.org/tlog-witness add-checkpoint request.
func addCheckpoint(t testing.TB, witnessURL string, old uint64, proof [][]byte, cp []byte) (int, []byte) {
	t.Helper()
	var b bytes.Buffer
	fmt.Fprintf(&b, "old %d\n", old)
	for _, p := range proof {
		fmt.Fprintf(&b, "%s\n", base64.StdEncoding.EncodeToString(p))
	}
	b.WriteString("\n")
	b.Write(cp)
	res, err := http.Post(witnessURL+"/add-checkpoint", "", &b)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, body
}

// knownSize asks the witness for the size it last cosigned for the
// conformance log: a request from a size it cannot know answers 409 with it.
func knownSize(t testing.TB, witnessURL string, s note.Signer) uint64 {
	t.Helper()
	const probe = 1 << 40
	status, body := addCheckpoint(t, witnessURL, probe-1, nil, conformance.SignedCheckpoint(s, probe, [32]byte{}))
	if status != http.StatusConflict {
		t.Fatalf("probe: %d %s", status, body)
	}
	n, err := strconv.ParseUint(strings.TrimSpace(string(body)), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// checkRefusesForks cosigns the conformance log one entry further, then
// requires the witness to refuse a fork at that size (422) and a rollback (409).
// It returns the size the witness now knows.
func checkRefusesForks(t *testing.T, witnessURL string, s note.Signer) uint64 {
	t.Helper()
	k := knownSize(t, witnessURL, s)
	n := k + 1
	status, body := addCheckpoint(t, witnessURL, k, conformance.Consistency(k, n), conformance.SignedCheckpoint(s, n, conformance.Tree(n)))
	if status != http.StatusOK {
		t.Fatalf("honest checkpoint %d → %d: %d %s", k, n, status, body)
	}
	checkRefusesFork(t, witnessURL, s, n)
	return n
}

// checkRefusesFork requires that the witness knows size n and refuses a
// different root at n and any smaller size.
func checkRefusesFork(t *testing.T, witnessURL string, s note.Signer, n uint64) {
	t.Helper()
	fork := conformance.Tree(n)
	fork[0] ^= 1
	if status, body := addCheckpoint(t, witnessURL, n, nil, conformance.SignedCheckpoint(s, n, fork)); status != http.StatusUnprocessableEntity {
		t.Fatalf("forked checkpoint at %d: %d %s", n, status, body)
	}
	if n > 1 {
		status, body := addCheckpoint(t, witnessURL, n-1, nil, conformance.SignedCheckpoint(s, n-1, conformance.Tree(n-1)))
		if status != http.StatusConflict || strings.TrimSpace(string(body)) != strconv.FormatUint(n, 10) {
			t.Fatalf("rolled back checkpoint at %d: %d %s", n-1, status, body)
		}
	}
}

// startWitnesses starts three witnesses for the test origins and the
// conformance log, and points the log's policies at them. It returns the
// conformance log's signer key.
func startWitnesses(t testing.TB, keys testKeys) ([]*testWitness, map[string]torchwood.Policy, string) {
	t.Helper()
	cskey, cvkey, err := note.GenerateKey(rand.Reader, conformance.Origin)
	if err != nil {
		t.Fatal(err)
	}
	logs := map[string]string{conformance.Origin: cvkey}
	for _, o := range originSpecs {
		logs[o.Name] = keys.vkeys[o.Name][0]
	}
	ws := []*testWitness{
		startWitness(t, "witness-1.test", logs),
		startWitness(t, "witness-2.test", logs),
		startWitness(t, "witness-3.test", logs),
	}
	policies := map[string]torchwood.Policy{}
	for _, o := range originSpecs {
		v := keys.vkeys[o.Name]
		p := witnessPolicy(v[:], ws)
		keys.writePolicy(t, o, p)
		if policies[o.Name], err = torchwood.ParsePolicy([]byte(p)); err != nil {
			t.Fatal(err)
		}
	}
	return ws, policies, cskey
}

func TestEveryCheckpointIsWitnessedTwoOfThree(t *testing.T) {
	vectors, _ := loadVectors(t)
	allow, deny, degraded := vectors["allow"], vectors["deny"], vectors["degraded"]
	db, dbURL := testDB(t)
	keys := newTestKeys(t)
	ws, policies, cskey := startWitnesses(t, keys)
	l := startLog(t, keys, t.TempDir(), db, dbURL)
	activate(t, db, teeTDX, *allow.Signers["tdx"], *allow.Measurements["tdx"])
	activate(t, db, teeNitro, *allow.Signers["nitro"], *allow.Measurements["nitro"])
	purchase(t, db, alibiID(t, allow.Leaf), ptr("2of2"))
	purchase(t, db, alibiID(t, deny.Leaf), ptr("2of2"))
	purchase(t, db, alibiID(t, degraded.Leaf), ptr("degraded"))
	origin := host + "/" + sandbox

	res, body := getPublic(t, l, sandbox+"/policy")
	if v := keys.vkeys[origin]; res.StatusCode != http.StatusOK || string(body) != witnessPolicy(v[:], ws) {
		t.Fatalf("policy: %d %q", res.StatusCode, body)
	}

	appendWitnessed := func(v vector, want int) {
		t.Helper()
		status, res := l.add(t, sandbox, testToken, v.Leaf, v.Countersign)
		if status != http.StatusOK {
			t.Fatalf("%s: %d %v", v.Name, status, res)
		}
		checkAppended(t, keys, l, v.Leaf, res)
		cp := []byte(res["checkpoint"])
		if _, _, err := torchwood.VerifyCheckpoint(cp, policies[origin]); err != nil {
			t.Fatalf("%s: the checkpoint does not satisfy the witness policy: %v", v.Name, err)
		}
		cs := cosigners(t, cp, ws)
		if len(cs) < want {
			t.Fatalf("%s: %d cosignatures, want %d", v.Name, len(cs), want)
		}
		for name, at := range cs {
			if d := time.Since(at); d < -5*time.Second || d > 5*time.Second {
				t.Fatalf("%s cosigned at %v", name, at)
			}
		}
	}
	appendWitnessed(allow, 2)

	// One witness down: two of three still cosign.
	ws[2].stop()
	appendWitnessed(deny, 2)

	// Two witnesses down: no new checkpoint is published and the append fails.
	ws[1].stop()
	_, before := getPublic(t, l, sandbox+"/checkpoint")
	activate(t, db, teeTDX, *degraded.Signers["tdx"], *degraded.Measurements["tdx"])
	status, out := l.add(t, sandbox, testToken, degraded.Leaf, degraded.Countersign)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("append without a witness quorum: %d %v", status, out)
	}
	if _, after := getPublic(t, l, sandbox+"/checkpoint"); !bytes.Equal(before, after) {
		t.Fatalf("a checkpoint was published without the quorum:\n%s", after)
	}

	// The witness that is still up refuses forks and rollbacks of a log it knows.
	s, err := note.NewSigner(cskey)
	if err != nil {
		t.Fatal(err)
	}
	n := checkRefusesForks(t, ws[0].url, s)
	n = checkRefusesForks(t, ws[0].url, s)
	if n != 2 {
		t.Fatalf("the witness knows size %d of the conformance log, want 2", n)
	}
}

func getPublic(t testing.TB, l *testLog, path string) (*http.Response, []byte) {
	t.Helper()
	res, err := http.Get(l.public.URL + "/" + path)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res, body
}
