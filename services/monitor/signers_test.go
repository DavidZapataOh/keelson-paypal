//go:build fork

package main

import (
	"context"
	"math/big"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DavidZapataOh/keelson-paypal/internal/alibilog"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/transparency-dev/tessera/api/layout"
	"github.com/transparency-dev/tessera/client"
)

// lastSignedLeaf returns the newest 2-of-2 leaf below size and its index.
func lastSignedLeaf(t *testing.T, f *follower, size uint64) (uint64, *alibilog.Leaf) {
	t.Helper()
	for i := size; i > 0; i-- {
		index := i - 1
		b, err := client.GetEntryBundle(context.Background(), f.fetcher.ReadEntryBundle, index/layout.EntryBundleWidth, size)
		if err != nil {
			t.Fatal(err)
		}
		raw := b.Entries[index%layout.EntryBundleWidth]
		if alibilog.IsStop(raw) {
			continue
		}
		l, err := alibilog.Parse(raw)
		if err == nil && l.Mode == alibilog.Mode2of2 {
			return index, l
		}
	}
	t.Fatal("no 2-of-2 leaf")
	return 0, nil
}

// checkedIndex syncs the registry and checks every leaf of the view.
func checkedIndex(t *testing.T, f *follower) (OriginState, *signerIndex) {
	t.Helper()
	cur := f.st.Get(f.o.Name)
	start := time.Now()
	sc, idx, fds := f.checkSigners(context.Background(), cur)
	t.Logf("signers: %d leaves checked, %d predate the registry, %d signers, block %d, in %v",
		sc.LeavesChecked, sc.Predating, len(idx.Signers), sc.Block, time.Since(start))
	if sc.Status != "checked" || len(fds) != 0 || sc.Next != cur.Size || sc.LeavesChecked == 0 {
		t.Fatalf("%+v %+v", sc, fds)
	}
	return cur, idx
}

// resign signs digest with key as a TEE leg does: r || s || v, v in {27, 28}.
func resign(t *testing.T, digest [32]byte) [65]byte {
	t.Helper()
	k, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	sig, err := crypto.Sign(digest[:], k)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27
	return [65]byte(sig)
}

func TestRealLeavesVerify(t *testing.T) {
	fork := startFork(t)
	f := realFollower(t, sandbox, fork.URL)
	checkedIndex(t, f)
}

func TestSignerRevokedAfterIssueStillValid(t *testing.T) {
	fork := startFork(t)
	f := realFollower(t, sandbox, fork.URL)
	cur, idx := checkedIndex(t, f)
	index, l := lastSignedLeaf(t, f, cur.Size)
	tdx, err := alibilog.Recover(l.CountersignDigest, l.TeeSigs[0])
	if err != nil {
		t.Fatal(err)
	}

	guardian := common.HexToAddress("0x1cd0152d2d954Fc8c9436986C9F4B2C15903eF5C")
	data := append(crypto.Keccak256([]byte("revokeSigner(address)"))[:4], common.LeftPadBytes(tdx[:], 32)...)
	fork.sendAs(t, guardian, f.o.Chain.VerdictVerifier, data)

	if _, err := f.chain.syncSigners(context.Background(), idx); err != nil {
		t.Fatal(err)
	}
	r := idx.Signers[common.Address(tdx)]
	if r.RevokedAt == 0 || r.RevokedAt <= uint64(l.IssuedAt.Unix()) {
		t.Fatalf("revocation not indexed: %+v", r)
	}
	if fd := checkLeafSigners(index, l, idx, f.o.Chain.CountersignWindow); fd != nil {
		t.Fatalf("a leaf signed before the revocation: %+v", fd)
	}
	after := *l
	after.IssuedAt = time.Unix(int64(r.RevokedAt), 0)
	if fd := checkLeafSigners(index, &after, idx, f.o.Chain.CountersignWindow); fd == nil || fd.Kind != "leaf.tee_signer" {
		t.Fatalf("a leaf issued at the revocation: %+v", fd)
	}
}

func TestUnknownSignerIsAFinding(t *testing.T) {
	fork := startFork(t)
	f := realFollower(t, sandbox, fork.URL)
	cur, idx := checkedIndex(t, f)
	index, l := lastSignedLeaf(t, f, cur.Size)
	l.TeeSigs[0] = resign(t, l.CountersignDigest)
	if fd := checkLeafSigners(index, l, idx, f.o.Chain.CountersignWindow); fd == nil || fd.Kind != "leaf.tee_signer" {
		t.Fatalf("%+v", fd)
	}
}

func TestMeasurementMismatchIsAFinding(t *testing.T) {
	fork := startFork(t)
	f := realFollower(t, sandbox, fork.URL)
	cur, idx := checkedIndex(t, f)
	index, l := lastSignedLeaf(t, f, cur.Size)
	l.Measurements[1][0] ^= 1
	if fd := checkLeafSigners(index, l, idx, f.o.Chain.CountersignWindow); fd == nil || fd.Kind != "leaf.tee_measurement" {
		t.Fatalf("%+v", fd)
	}
}

func TestIndexResumes(t *testing.T) {
	fork := startFork(t)
	f := realFollower(t, sandbox, fork.URL)
	f.checkChain(context.Background())
	first := f.st.Get(f.o.Name)
	if first.SignerIndex == nil || first.Signers.Status != "checked" {
		t.Fatalf("%+v", first.Signers)
	}

	st, err := openState(fileDir(f.st))
	if err != nil {
		t.Fatal(err)
	}
	reopened := st.Get(f.o.Name)
	idx := reopened.SignerIndex
	regs := map[common.Address]int{}
	for a, r := range idx.Signers {
		regs[a] = len(r.Registrations)
	}
	if _, err := f.chain.syncSigners(context.Background(), idx); err != nil {
		t.Fatal(err)
	}
	for a, r := range idx.Signers {
		if len(r.Registrations) != regs[a] {
			t.Fatalf("signer %s re-read from before block %d", a, reopened.SignerIndex.Block)
		}
	}
	if reopened.Signers.Next != first.Signers.Next || idx.Block < first.SignerIndex.Block {
		t.Fatalf("cursor lost: %+v vs %+v", reopened.Signers, first.Signers)
	}
}

func fileDir(s *State) string { return filepath.Dir(s.path) }

// signersSlot finds the slot of VerdictVerifier's signer mapping from a
// signer the registry holds.
func signersSlot(t *testing.T, fork *anvilFork, vv common.Address, known common.Address) common.Hash {
	t.Helper()
	for n := int64(0); n < 32; n++ {
		slot := common.BigToHash(big.NewInt(n))
		if fork.storage(t, vv, mappingSlot(known.Bytes(), slot)) != (common.Hash{}) {
			return slot
		}
	}
	t.Fatal("signer mapping not found")
	return common.Hash{}
}

var reportEquivocationABI = func() abi.ABI {
	a, err := abi.JSON(strings.NewReader(`[{"type":"function","name":"reportEquivocation","inputs":[
{"name":"a","type":"tuple","components":` + countersignComponents + `},
{"name":"b","type":"tuple","components":` + countersignComponents + `},
{"name":"sigA","type":"bytes"},{"name":"sigB","type":"bytes"}]}]`))
	if err != nil {
		panic(err)
	}
	return a
}()

const countersignComponents = `[{"name":"requestId","type":"bytes32"},{"name":"mandateHash","type":"bytes32"},
{"name":"mandateCommitment","type":"bytes32"},{"name":"cartHash","type":"bytes32"},{"name":"agentId","type":"uint256"},
{"name":"merchantId","type":"bytes32"},{"name":"amount","type":"uint64"},{"name":"currency","type":"uint16"},
{"name":"category","type":"uint8"},{"name":"evidenceRoot","type":"bytes32"},{"name":"evalHash","type":"bytes32"},
{"name":"policySetHash","type":"bytes32"},{"name":"decision","type":"uint8"},{"name":"failedFieldsMask","type":"uint32"},
{"name":"issuedAt","type":"uint40"},{"name":"expiresAt","type":"uint40"}]`

// abiCountersign is c as go-ethereum's ABI encoder takes the tuple.
type abiCountersign struct {
	RequestId         [32]byte
	MandateHash       [32]byte
	MandateCommitment [32]byte
	CartHash          [32]byte
	AgentId           *big.Int
	MerchantId        [32]byte
	Amount            uint64
	Currency          uint16
	Category          uint8
	EvidenceRoot      [32]byte
	EvalHash          [32]byte
	PolicySetHash     [32]byte
	Decision          uint8
	FailedFieldsMask  uint32
	IssuedAt          *big.Int
	ExpiresAt         *big.Int
}

func toABI(c alibilog.Countersign) abiCountersign {
	return abiCountersign{c.RequestID, c.MandateHash, c.MandateCommitment, c.CartHash, c.AgentID, c.MerchantID,
		c.Amount, c.Currency, c.Category, c.EvidenceRoot, c.EvalHash, c.PolicySetHash, c.Decision, c.FailedFieldsMask,
		new(big.Int).SetUint64(c.IssuedAt), new(big.Int).SetUint64(c.ExpiresAt)}
}

// TestEquivocatedSignerFlagsEveryLeaf registers a fresh key on the fork by
// copying the record of the TDX signer of a real leaf into its storage, has
// it sign two countersigns with the same request id, and reports them to
// VerdictVerifier, which emits SignerEquivocated. A storage write emits no
// SignerRegistered, so the index takes the copied registration as the
// registry holds it.
func TestEquivocatedSignerFlagsEveryLeaf(t *testing.T) {
	fork := startFork(t)
	f := realFollower(t, sandbox, fork.URL)
	cur, idx := checkedIndex(t, f)
	index, l := lastSignedLeaf(t, f, cur.Size)
	vv := f.o.Chain.VerdictVerifier
	tdx, err := alibilog.Recover(l.CountersignDigest, l.TeeSigs[0])
	if err != nil {
		t.Fatal(err)
	}

	k, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	fresh := crypto.PubkeyToAddress(k.PublicKey)
	slot := signersSlot(t, fork, vv, common.Address(tdx))
	from, to := mappingSlot(common.Address(tdx).Bytes(), slot), mappingSlot(fresh.Bytes(), slot)
	for i := int64(0); i < 2; i++ {
		off := func(h common.Hash) common.Hash { return common.BigToHash(new(big.Int).Add(h.Big(), big.NewInt(i))) }
		fork.setStorage(t, vv, off(to), fork.storage(t, vv, off(from)))
	}
	rec := *idx.Signers[common.Address(tdx)]
	rec.Leaves = nil
	idx.Signers[fresh] = &rec

	sign := func(digest [32]byte) [65]byte {
		sig, err := crypto.Sign(digest[:], k)
		if err != nil {
			t.Fatal(err)
		}
		sig[64] += 27
		return [65]byte(sig)
	}
	// Two leaves signed by the fresh key pass while it is not known to have
	// equivocated.
	signed := func(i uint64) (uint64, *alibilog.Leaf) {
		c := *l
		c.TeeSigs = append([][65]byte{}, l.TeeSigs...)
		c.CountersignDigest[31] ^= byte(i)
		c.TeeSigs = c.TeeSigs[:1]
		c.Measurements = l.Measurements[:1]
		c.TeeSigs[0] = sign(c.CountersignDigest)
		return index - i, &c
	}
	for i := uint64(1); i <= 2; i++ {
		n, leaf := signed(i)
		if fd := checkLeafSigners(n, leaf, idx, f.o.Chain.CountersignWindow); fd != nil {
			t.Fatalf("leaf %d before the equivocation: %+v", n, fd)
		}
	}

	now := uint64(time.Now().Unix())
	a := alibilog.Countersign{AgentID: big.NewInt(1), IssuedAt: now, ExpiresAt: now + 600, Amount: 1}
	a.RequestID[0] = 1
	b := a
	b.Amount = 2
	da, db := alibilog.Digest(a, f.o.Chain.ChainID, vv), alibilog.Digest(b, f.o.Chain.ChainID, vv)
	sa, sb := sign(da), sign(db)
	data, err := reportEquivocationABI.Pack("reportEquivocation", toABI(a), toABI(b), sa[:], sb[:])
	if err != nil {
		t.Fatal(err)
	}
	fork.sendAs(t, common.HexToAddress("0x000000000000000000000000000000000000dEaD"), vv, data)

	fds, err := f.chain.syncSigners(context.Background(), idx)
	if err != nil {
		t.Fatal(err)
	}
	if len(fds) != 2 || fds[0].Kind != "leaf.tee_equivocated" || *fds[0].Index != index-1 || *fds[1].Index != index-2 {
		t.Fatalf("leaves already checked: %+v", fds)
	}
	n, leaf := signed(3)
	if fd := checkLeafSigners(n, leaf, idx, f.o.Chain.CountersignWindow); fd == nil || fd.Kind != "leaf.tee_equivocated" {
		t.Fatalf("a later leaf: %+v", fd)
	}
	if fd := checkLeafSigners(index, l, idx, f.o.Chain.CountersignWindow); fd != nil {
		t.Fatalf("the real signer's leaf: %+v", fd)
	}
}
