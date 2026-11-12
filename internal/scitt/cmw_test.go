// Package scitt holds the vendored CDDL and the cross-language checks of the SCITT envelope.
package scitt

import (
	"os"
	"testing"

	"github.com/veraison/cmw"
)

func TestCmwInterop(t *testing.T) {
	raw, err := os.ReadFile("testdata/cmw.json")
	if err != nil {
		t.Fatal(err)
	}
	var c cmw.CMW
	if err := c.UnmarshalJSON(raw); err != nil {
		t.Fatalf("veraison/cmw refuses the collection: %v", err)
	}
	if err := c.Valid(); err != nil {
		t.Fatalf("veraison/cmw: %v", err)
	}
	if c.GetKind() != cmw.KindCollection {
		t.Fatalf("kind %v, want a collection", c.GetKind())
	}
	typ, err := c.GetCollectionType()
	if err != nil || typ != "tag:keelson.finance,2026:tee-legs" {
		t.Fatalf("collection type %q: %v", typ, err)
	}
	for _, label := range []string{"tdx", "nitro"} {
		item, err := c.GetCollectionItem(label)
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		if mt, _ := item.GetMonadType(); mt != "application/vnd.keelson.tee-evidence+json" {
			t.Fatalf("%s type %q", label, mt)
		}
		ind, err := item.GetMonadIndicator()
		if err != nil || !ind.Has(cmw.Evidence) {
			t.Fatalf("%s is not marked as evidence", label)
		}
	}
}
