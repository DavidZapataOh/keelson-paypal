package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// legTimeout bounds a leg's checkpoint signature, which takes under a
// millisecond in the engine.
const legTimeout = 10 * time.Second

// legClient asks one TEE leg to sign the EIP-712 Checkpoint of a witnessed
// checkpoint (POST /v1/checkpoint).
type legClient struct {
	url   string
	token string
	http  *http.Client
}

func newLegClient(url, token string) *legClient {
	return &legClient{url: strings.TrimSuffix(url, "/"), token: token, http: &http.Client{Timeout: legTimeout}}
}

// legCheckpoint is the leg's answer.
type legCheckpoint struct {
	Origin    string `json:"origin"`
	TreeSize  string `json:"tree_size"`
	RootHash  string `json:"root_hash"`
	ChainID   uint64 `json:"chain_id"`
	Digest    string `json:"digest"`
	Signature string `json:"signature"`
	Signer    string `json:"signer"`
}

func (c *legClient) checkpoint(ctx context.Context, signedNote []byte, chainID uint64) (*legCheckpoint, error) {
	body, err := json.Marshal(map[string]any{"signed_note": string(signedNote), "chain_id": chainID})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url+"/v1/checkpoint", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		var p struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(raw, &p)
		return nil, fmt.Errorf("%s: %s", resp.Status, p.Code)
	}
	var out legCheckpoint
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
