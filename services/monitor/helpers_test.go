package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"filippo.io/torchwood"
	"github.com/DavidZapataOh/keelson-paypal/internal/alibilog"
	"github.com/transparency-dev/tessera"
	"github.com/transparency-dev/tessera/storage/posix"
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

// testWitness is litewitness started by the witness image's entrypoint.
type testWitness struct {
	name string
	key  ed25519.PrivateKey
	url  string
	vkey string
	cmd  *exec.Cmd
	done chan struct{}
}

// startWitness runs services/witness/entrypoint.sh with a fresh database,
// cosigning the logs in logs (origin → log vkey). A nil key is generated.
func startWitness(t testing.TB, name string, key ed25519.PrivateKey, logs map[string]string) *testWitness {
	t.Helper()
	if key == nil {
		_, key, _ = ed25519.GenerateKey(rand.Reader)
	}
	block, err := ssh.MarshalPrivateKey(key, "")
	if err != nil {
		t.Fatal(err)
	}
	signer, err := torchwood.NewCosignatureSigner(name, key)
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
	env := []string{
		"PATH=" + litewitnessBin(t) + ":" + os.Getenv("PATH"),
		"HOME=" + dir,
		"WITNESS_NAME=" + name,
		"WITNESS_KEY=" + string(pem.EncodeToMemory(block)),
		"WITNESS_LOGS=" + strings.Join(pairs, ";"),
		"DB=" + filepath.Join(dir, "litewitness.db"),
		"LITEWITNESS_SOCK=" + filepath.Join(dir, "agent.sock"),
	}
	// Another test process can bind the port between freePort and litewitness, and then answers
	// in its place: the witness is up only once it serves its own key, and starts again on
	// another port if it exits.
	var stderr bytes.Buffer
	for range 3 {
		port := freePort(t)
		cmd := exec.Command("sh", "../witness/entrypoint.sh")
		cmd.Env = append(env, "PORT="+strconv.Itoa(port))
		// The witness and its ssh-agent share a process group, stopped together.
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		stderr.Reset()
		cmd.Stderr = &stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		w := &testWitness{name: name, key: key, url: fmt.Sprintf("http://127.0.0.1:%d", port), vkey: signer.Verifier().String(), cmd: cmd, done: make(chan struct{})}
		go func() {
			_ = cmd.Wait()
			close(w.done)
		}()
		t.Cleanup(w.stop)
		if w.ready(10 * time.Second) {
			return w
		}
		w.stop()
	}
	t.Fatalf("%s did not start: %s", name, stderr.String())
	return nil
}

// ready reports whether the witness serves its index, with its own key, before timeout.
func (w *testWitness) ready(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case <-w.done:
			return false
		default:
		}
		if res, err := http.Get(w.url + "/"); err == nil {
			body, _ := io.ReadAll(res.Body)
			res.Body.Close()
			if res.StatusCode == http.StatusOK && bytes.Contains(body, []byte(w.vkey)) {
				return true
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func (w *testWitness) stop() {
	_ = syscall.Kill(-w.cmd.Process.Pid, syscall.SIGKILL)
	<-w.done
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

// testOrigin is the origin of the local logs the tests run.
const testOrigin = "log.keelson.finance/alibi/2026-1"

// logKeys are a log's Ed25519 key.
type logKeys struct {
	signer note.Signer
	vkey   string
}

func newLogKeys(t testing.TB, origin string) *logKeys {
	t.Helper()
	skey, vkey, err := note.GenerateKey(rand.Reader, origin)
	if err != nil {
		t.Fatal(err)
	}
	s, err := note.NewSigner(skey)
	if err != nil {
		t.Fatal(err)
	}
	return &logKeys{signer: s, vkey: vkey}
}

// startWitnesses starts three witnesses for origin. With keys from an earlier
// set, they are the same witnesses with their state wiped, which is what a
// colluding witness looks like.
func (k *logKeys) startWitnesses(t testing.TB, origin string, same []*testWitness) []*testWitness {
	t.Helper()
	var ws []*testWitness
	for i := range 3 {
		var key ed25519.PrivateKey
		if same != nil {
			key = same[i].key
		}
		ws = append(ws, startWitness(t, fmt.Sprintf("witness-%d.test", i+1), key, map[string]string{origin: k.vkey}))
	}
	return ws
}

// policy is the witness policy of the log: its key and two of three witnesses.
func witnessPolicy(vkey string, ws []*testWitness) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "log %s\n", vkey)
	var names []string
	for i, w := range ws {
		fmt.Fprintf(&b, "witness w%d %s %s\n", i+1, w.vkey, w.url)
		names = append(names, fmt.Sprintf("w%d", i+1))
	}
	fmt.Fprintf(&b, "group own 2 %s\nquorum own\n", strings.Join(names, " "))
	return []byte(b.String())
}

// testLog is a Tessera log on a directory, appended to directly, as an
// operator who bypasses admission could.
type testLog struct {
	dir      string
	add      tessera.AddFn
	awaiter  *tessera.PublicationAwaiter
	shutdown func(context.Context) error
	cancel   context.CancelFunc
}

// openTestLog opens the log in dir, signed by signer and cosigned by the
// witnesses of the policy wp, if any.
func openTestLog(t testing.TB, dir string, signer note.Signer, wp []byte) *testLog {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	driver, err := posix.New(ctx, posix.Config{Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	opts := tessera.NewAppendOptions().
		WithCheckpointSigner(signer).
		WithCheckpointInterval(100*time.Millisecond).
		WithCheckpointRepublishInterval(0).
		WithBatching(256, 20*time.Millisecond)
	if wp != nil {
		g, err := tessera.NewWitnessGroupFromPolicy(wp)
		if err != nil {
			t.Fatal(err)
		}
		opts = opts.WithWitnesses(g, &tessera.WitnessOptions{Timeout: 2 * time.Second})
	}
	appender, shutdown, reader, err := tessera.NewAppender(ctx, driver, opts)
	if err != nil {
		t.Fatal(err)
	}
	l := &testLog{
		dir:      dir,
		add:      appender.Add,
		awaiter:  tessera.NewPublicationAwaiter(ctx, reader.ReadCheckpoint, 10*time.Millisecond),
		shutdown: shutdown,
		cancel:   cancel,
	}
	t.Cleanup(func() { l.close(t) })
	return l
}

// append adds the leaves and waits for a checkpoint covering all of them.
func (l *testLog) append(t testing.TB, leaves ...[]byte) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	futures := make([]tessera.IndexFuture, len(leaves))
	for i, leaf := range leaves {
		futures[i] = l.add(ctx, tessera.NewEntry(leaf))
	}
	var cp []byte
	for _, f := range futures {
		_, c, err := l.awaiter.Await(ctx, f)
		if err != nil {
			t.Fatal(err)
		}
		cp = c
	}
	return cp
}

func (l *testLog) close(t testing.TB) {
	if l.cancel == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = l.shutdown(ctx)
	l.cancel()
	l.cancel = nil
}

// logServer serves a log directory as c2sp.org/tlog-tiles. The directory it
// serves can be switched, as a log serving a split view would.
type logServer struct {
	*httptest.Server
	dir atomic.Pointer[string]
}

func serveLog(t testing.TB, dir string) *logServer {
	t.Helper()
	s := &logServer{}
	s.dir.Store(&dir)
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		http.FileServer(http.Dir(*s.dir.Load())).ServeHTTP(w, r)
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *logServer) switchTo(dir string) { s.dir.Store(&dir) }

// copyDir copies a closed log's directory.
func copyDir(t testing.TB, src, dst string) {
	t.Helper()
	if err := os.CopyFS(dst, os.DirFS(src)); err != nil {
		t.Fatal(err)
	}
	// os.CopyFS makes files read-only; Tessera rewrites them.
	_ = filepath.WalkDir(dst, func(p string, d fs.DirEntry, err error) error {
		if err == nil {
			_ = os.Chmod(p, map[bool]os.FileMode{true: 0o755, false: 0o644}[d.IsDir()])
		}
		return err
	})
}

type vector struct {
	Name string `json:"name"`
	Mode string `json:"mode"`
	Leaf []byte `json:"leaf"`
}

func loadVectors(t testing.TB) map[string]vector {
	t.Helper()
	raw, err := os.ReadFile("../../packages/log/test/vectors/leaf.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Positive []vector `json:"positive"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	out := map[string]vector{}
	for _, p := range v.Positive {
		out[p.Name] = p
	}
	return out
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func newULID() string {
	b := make([]byte, 26)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = crockford[b[i]&31]
	}
	b[0] = crockford[b[0]&7]
	return string(b)
}

// rewrite changes a leaf's body and re-encodes it canonically.
func rewrite(t testing.TB, leaf []byte, change func(m map[string]any)) []byte {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(leaf[len(alibilog.Prefix):], &m); err != nil {
		t.Fatal(err)
	}
	change(m)
	body, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return append([]byte(alibilog.Prefix), body...)
}

// freshLeaves returns n canonical leaves made from the vector with fresh
// alibi_ids.
func freshLeaves(t testing.TB, v vector, n int) [][]byte {
	t.Helper()
	out := make([][]byte, n)
	for i := range out {
		out[i] = rewrite(t, v.Leaf, func(m map[string]any) { m["alibi_id"] = newULID() })
		if _, err := alibilog.Parse(out[i]); err != nil {
			t.Fatal(err)
		}
	}
	return out
}

// testMonitor runs one follower on a state directory.
type testMonitor struct {
	st     *State
	o      *origin
	events chan Event
	cancel context.CancelFunc
	done   chan struct{}
}

func startMonitor(t testing.TB, dataDir string, o *origin) *testMonitor {
	t.Helper()
	st, err := openState(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &testMonitor{st: st, o: o, events: make(chan Event, 1024), cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(m.done)
		Follow(ctx, o, st, pollInterval, nil, http.DefaultClient, m.events, slog.New(slog.DiscardHandler))
	}()
	t.Cleanup(m.stop)
	return m
}

func (m *testMonitor) stop() {
	m.cancel()
	<-m.done
}

func (m *testMonitor) report() Report { return buildReport(m.o, m.st) }

// waitFor polls the monitor's report until ok, for up to d.
func (m *testMonitor) waitFor(t testing.TB, d time.Duration, ok func(Report) bool) Report {
	t.Helper()
	deadline := time.Now().Add(d)
	for {
		r := m.report()
		if ok(r) {
			return r
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out; report: %+v", r)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// equivocation waits for the follower to emit an equivocation.
func (m *testMonitor) equivocation(t testing.TB, d time.Duration) *Equivocation {
	t.Helper()
	timeout := time.After(d)
	for {
		select {
		case e := <-m.events:
			if e.Equivocation != nil {
				return e.Equivocation
			}
		case <-timeout:
			t.Fatalf("no equivocation; report: %+v", m.report())
		}
	}
}

func hasFinding(r Report, kind string) bool {
	for _, f := range r.Findings {
		if f.Kind == kind {
			return true
		}
	}
	return false
}

func testOriginAt(t testing.TB, url string, p []byte) *origin {
	t.Helper()
	o, err := newOrigin(testOrigin, url+"/", p)
	if err != nil {
		t.Fatal(err)
	}
	return o
}
