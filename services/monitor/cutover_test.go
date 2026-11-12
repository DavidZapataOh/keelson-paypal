package main

import "testing"

// The cutover size of a key move is the size the log anchored when the new
// key signed its first checkpoint; a retired key without it covers every size.
func TestNoRetiredKeyWaitsForItsCutover(t *testing.T) {
	for origin, keys := range retiredKeys {
		for _, k := range keys {
			if k.untilSize == cutoverPending {
				t.Errorf("%s: %s has no cutover size", origin, k.vkey)
			}
		}
	}
}
