package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/DavidZapataOh/keelson-paypal/internal/alibilog"
)

func (l *testLog) stop(t testing.TB, token string, leaf []byte) (int, map[string]string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"leaf": leaf})
	req, _ := http.NewRequest(http.MethodPost, l.private.URL+"/"+sandbox+"/stop", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := map[string]string{}
	_ = json.Unmarshal(raw, &out)
	return res.StatusCode, out
}

func stopLeaf(id string, count int) []byte {
	d := alibilog.MandatesDigest([][32]byte{{byte(count)}})
	w := map[string]any{
		"issued_at":       "2026-11-11T09:00:00Z",
		"mandate_count":   count,
		"mandates_digest": base64.RawURLEncoding.EncodeToString(d[:]),
		"stop_id":         id,
	}
	body, _ := json.Marshal(w)
	return append([]byte(alibilog.StopPrefix), body...)
}

func TestAppendsAStopOnce(t *testing.T) {
	db, dbURL := testDB(t)
	keys := newTestKeys(t)
	l := startLog(t, keys, logDir(t), db, dbURL)
	leaf := stopLeaf("01KA0000000000000000000001", 2)

	if status, _ := l.stop(t, "", leaf); status != http.StatusUnauthorized {
		t.Fatalf("an unauthenticated stop: %d", status)
	}
	status, res := l.stop(t, testToken, leaf)
	if status != http.StatusOK {
		t.Fatalf("%d %v", status, res)
	}
	checkAppended(t, keys, l, leaf, res)
	status, again := l.stop(t, testToken, leaf)
	if status != http.StatusOK || again["index"] != res["index"] {
		t.Fatalf("the same stop again: %d %v", status, again)
	}
	if status, res := l.stop(t, testToken, stopLeaf("01KA0000000000000000000001", 3)); status != http.StatusConflict {
		t.Fatalf("another leaf for the same stop: %d %v", status, res)
	}
	if status, res := l.stop(t, testToken, append([]byte(alibilog.Prefix), leaf[len(alibilog.StopPrefix):]...)); status != http.StatusUnprocessableEntity || res["code"] != "leaf.prefix" {
		t.Fatalf("an Alibi prefix on the stop path: %d %v", status, res)
	}
	// The countersigned path admits no stop.
	if status, _ := l.add(t, sandbox, testToken, leaf, alibilog.Countersign{}); status != http.StatusUnprocessableEntity {
		t.Fatalf("a stop on the add path: %d", status)
	}
}
