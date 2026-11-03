"""Proof artboard: a rewrite of the record, caught.

Left, the transparency log of one order. Right, the inclusion proof: the log's
entries hash up a Merkle tree to a root, compared against the checkpoint that
was published on-chain at the time.

- Verified (`forged` false): the proof walks up from the countersignature entry,
  the computed root matches the published checkpoint.
- Forged (`forged` true): the log's operator rewrites entry #1203 to say the
  user approved $340 and re-signs it. The signature still checks out. The
  changed leaf changes every hash on its way up, the root no longer matches the
  checkpoint, and the rewrite is caught.
"""

from rml import (
    BONE, EASE_IO, EASE_OUT, GRAPHITE, LINE, OK, OP, SX, SY, TEXT2, TRIM_END, VERMILION,
    VERMILION_DEEP, WHITE, X, Y, Builder, Timeline, bool_condition, write,
)

b = Builder(3000)
W, H = 760, 460

parts = []
add = parts.append

# ---------------------------------------------------------------- panels
LOG_CX, PROOF_CX = 210, 585
add(b.rect(LOG_CX, 230, 380, 420, r=14, fill=BONE, stroke=GRAPHITE, name="Log panel")[1])
add(b.rect(PROOF_CX, 230, 330, 420, r=14, fill=BONE, stroke=GRAPHITE, name="Proof panel")[1])
proof_flash, xml = b.rect(PROOF_CX, 230, 330, 420, r=14, stroke=VERMILION, thick=3, opacity=0, name="Proof flash")
add(xml)

add(b.text(40, 48, "TRANSPARENCY LOG", 12.5, GRAPHITE, 500)[1])
add(b.text(380, 48, "ORDER 7RX-2214", 12.5, TEXT2, ox=1)[1])
add(b.rect(LOG_CX, 78, 380, 1.5, fill=GRAPHITE)[1])
add(b.text(440, 48, "INCLUSION PROOF", 12.5, GRAPHITE, 500)[1])
add(b.rect(PROOF_CX, 78, 330, 1.5, fill=GRAPHITE)[1])

# ---------------------------------------------------------------- the log
ENTRY_Y = [112, 170, 228, 286]
ENTRIES = [
    ("#1201", "MANDATE SIGNED · PASSKEY", "7b2e"),
    ("#1202", "CART CHECKED · INSIDE", "a1f3"),
    ("#1203", "COUNTERSIGNED · $94.00", "c7d2"),
    ("#1204", "CAPTURED · VIA PAYPAL", "5d80"),
]
for (idx, label, h), y in zip(ENTRIES, ENTRY_Y):
    add(b.rect(LOG_CX, y, 340, 46, r=6, fill=WHITE, stroke=LINE, name=f"Entry {idx}")[1])
    add(b.text(56, y, idx, 12, TEXT2)[1])
    if idx != "#1203":
        add(b.text(110, y, label, 13, GRAPHITE)[1])
        add(b.text(364, y, h, 12, TEXT2, ox=1)[1])

FORGED_Y = ENTRY_Y[2]
entry_flash, xml = b.rect(LOG_CX, FORGED_Y, 340, 46, r=6, stroke=VERMILION, thick=2, opacity=0, name="Entry flash")
add(xml)
entry_ok, xml = b.text(110, FORGED_Y, "COUNTERSIGNED · $94.00", 13, GRAPHITE)
add(xml)
entry_bad, xml = b.text(110, FORGED_Y, "USER APPROVED $340.00", 13, VERMILION_DEEP, 600, opacity=0)
add(xml)
hash_ok, xml = b.text(364, FORGED_Y, "c7d2", 12, TEXT2, ox=1)
add(xml)
hash_bad, xml = b.text(364, FORGED_Y, "e91b", 12, VERMILION_DEEP, 600, ox=1, opacity=0)
add(xml)

# the signature row: it stays valid, which is the point
SIG_Y = 352
add(b.rect(LOG_CX, 322, 340, 1, fill=LINE)[1])
add(b.text(40, SIG_Y, "SIGNATURE", 12, TEXT2)[1])
sig_box, xml = b.node(
    120,
    SIG_Y,
    [b.rect(0, 0, 16, 16, r=3, fill=OK)[1], b.check_mark(BONE, 0.9)],
    name="Sig tick",
)
add(xml)
add(b.text(136, SIG_Y, "VALID", 12, OK, 600)[1])
resigned, xml = b.text(186, SIG_Y, "· RE-SIGNED BY THE OPERATOR", 12, TEXT2, opacity=0)
add(xml)
add(b.text(40, 400, "A SIGNED LOG ACCEPTS THE REWRITE.", 11, TEXT2)[1])

# ---------------------------------------------------------------- the proof
add(b.text(440, 104, "COMPUTED", 11.5, TEXT2)[1])
add(b.text(440, 130, "PUBLISHED", 11.5, TEXT2)[1])
root_ok, xml = b.text(530, 104, "9f3a…c21e", 13, GRAPHITE, 500)
add(xml)
root_bad, xml = b.text(530, 104, "4c07…b88d", 13, VERMILION_DEEP, 600, opacity=0)
add(xml)
add(b.text(530, 130, "9f3a…c21e", 13, GRAPHITE, 500)[1])
add(b.text(730, 130, "ON-CHAIN", 10.5, TEXT2, 500, ox=1)[1])

ROOT = (585, 186)
MID = [(507, 252), (663, 252)]
LEAVES = [(468, 318), (546, 318), (624, 318), (702, 318)]
EDGES = [(LEAVES[0], MID[0]), (LEAVES[1], MID[0]), (LEAVES[2], MID[1]), (LEAVES[3], MID[1]), (MID[0], ROOT), (MID[1], ROOT)]

for a, c in EDGES:
    add(b.line(*a, *c, stroke=LINE, thick=2)[1])

# overlays that draw along the path from the changed leaf: leaf 3 -> mid 2 -> root
trims = {}
for name, (a, c) in {"leaf": (LEAVES[2], MID[1]), "mid": (MID[1], ROOT)}.items():
    for tone, color in (("ok", OK), ("bad", VERMILION)):
        tid = b.nid()
        add(b.line(*a, *c, stroke=color, thick=2.5, trim=(tid, 0, 0), name=f"Path {name} {tone}")[1])
        trims[(name, tone)] = tid


def tree_node(x, y, d, label=None):
    add(b.ellipse(x, y, d, fill=BONE, stroke=GRAPHITE, thick=1.5)[1])
    if label:
        add(b.text(x, y + 24, label, 10.5, TEXT2, ox=0.5)[1])


tree_node(*ROOT, 22)
for m in MID:
    tree_node(*m, 16)
for (x, y), (idx, _, _) in zip(LEAVES, ENTRIES):
    tree_node(x, y, 14, idx)

# colour states for the nodes on the path
fills = {}
for key, (x, y), d in (("leaf", LEAVES[2], 14), ("mid", MID[1], 16), ("root", ROOT, 22)):
    for tone, color in (("ok", OK), ("bad", VERMILION)):
        sid, xml = b.ellipse(x, y, d, fill=color, opacity=0, name=f"Node {key} {tone}")
        add(xml)
        fills[(key, tone)] = sid

root_ring, xml = b.ellipse(*ROOT, 22, stroke=VERMILION, thick=2, opacity=0, name="Root ring")
add(xml)


def chip(label, width, bg, fg, border=None, opacity=0):
    cid, xml = b.node(
        PROOF_CX,
        396,
        [b.rect(0, 0, width, 34, r=4, fill=bg, stroke=border)[1], b.text(0, 0, label, 12.5, fg, 600, ox=0.5)[1]],
        opacity=opacity,
        name=f"Chip {label}",
    )
    add(xml)
    return cid


chip_check = chip("VERIFYING", 120, BONE, TEXT2, border=LINE, opacity=1)
chip_ok = chip("MATCHES THE CHECKPOINT", 236, GRAPHITE, BONE)
chip_bad = chip("REWRITE DETECTED · #1203", 252, VERMILION, GRAPHITE)

# the operator's cursor
ripple, ripple_xml = b.ellipse(0, 0, 30, stroke=VERMILION, thick=2, opacity=0, name="Ripple")
cursor, xml = b.node(
    120,
    520,
    [
        ripple_xml,
        b.poly([(0, 0), (0, 23), (6, 17.5), (10.5, 27), (14.5, 25), (10, 16), (18, 16)],
               fill=VERMILION_DEEP, stroke=BONE, thick=1.5, name="Arrow")[1],
        b.rect(22, 34, 82, 20, r=4, ox=0, fill=VERMILION_DEEP)[1],
        b.text(63, 34, "OPERATOR", 10, BONE, 600, ox=0.5)[1],
    ],
    name="Operator cursor",
)
add(xml)

# ---------------------------------------------------------------- timelines
D = {}
for obj, v in [
    (entry_flash, 0), (entry_ok, 1), (entry_bad, 0), (hash_ok, 1), (hash_bad, 0), (resigned, 0),
    (root_ok, 1), (root_bad, 0), (root_ring, 0), (proof_flash, 0), (ripple, 0),
    (chip_check, 1), (chip_ok, 0), (chip_bad, 0),
] + [(f, 0) for f in fills.values()]:
    D[(obj, OP)] = v
for t in trims.values():
    D[(t, TRIM_END)] = 0
for obj in [chip_ok, chip_bad, root_ring, *fills.values()]:
    D[(obj, SX)] = D[(obj, SY)] = 1
D[(ripple, SX)] = D[(ripple, SY)] = 0.3
for obj, y in [(entry_ok, FORGED_Y), (entry_bad, FORGED_Y), (hash_ok, FORGED_Y), (hash_bad, FORGED_Y), (root_ok, 104), (root_bad, 104)]:
    D[(obj, Y)] = y
D[(cursor, X)] = 120
D[(cursor, Y)] = 520


def walk(tl, tone, at):
    """The proof climbs from the changed leaf to the root."""
    tl.pop(fills[("leaf", tone)], at, start=0.3, dur=14)
    tl.key(trims[("leaf", tone)], TRIM_END, [(0, 0), (at + 6, 0), (at + 26, 1)], EASE_IO)
    tl.pop(fills[("mid", tone)], at + 26, start=0.3, dur=14)
    tl.key(trims[("mid", tone)], TRIM_END, [(0, 0), (at + 32, 0), (at + 54, 1)], EASE_IO)
    tl.pop(fills[("root", tone)], at + 54, start=0.3, dur=16)
    return at + 60


verified = Timeline(D)
end = walk(verified, "ok", 24)
verified.fade(chip_check, end, 0, 6)
verified.pop(chip_ok, end + 4, start=0.86, dur=16)
VERIFIED_LEN = end + 40

forged = Timeline(D)
forged.key(cursor, X, [(0, 120), (30, 250), (44, 250), (74, 520)], EASE_IO)
forged.key(cursor, Y, [(0, 520), (30, FORGED_Y + 8), (44, FORGED_Y + 8), (74, 470)], EASE_IO)
forged.key(ripple, OP, [(0, 0), (32, 0), (34, 1), (54, 0)])
forged.key(ripple, SX, [(0, 0.3), (32, 0.3), (54, 1.7)], EASE_OUT)
forged.key(ripple, SY, [(0, 0.3), (32, 0.3), (54, 1.7)], EASE_OUT)
forged.key(entry_flash, OP, [(0, 0), (34, 0), (40, 1)], EASE_OUT)
forged.slide_out(entry_ok, 36, FORGED_Y).slide_in(entry_bad, 38, FORGED_Y)
forged.key(hash_ok, OP, [(0, 1), (50, 1), (54, 0)])
forged.key(hash_bad, OP, [(0, 0), (54, 0), (56, 1), (59, 0.2), (62, 1), (65, 0.3), (68, 1)])
forged.fade(resigned, 66, 1, 12)
end = walk(forged, "bad", 80)
forged.slide_out(root_ok, end - 4, 104, dist=8).slide_in(root_bad, end - 2, 104, dist=8)
forged.key(root_ring, OP, [(0, 0), (end - 6, 0), (end - 4, 1), (end + 22, 0)])
forged.key(root_ring, SX, [(0, 1), (end - 6, 1), (end + 22, 2.4)], EASE_OUT)
forged.key(root_ring, SY, [(0, 1), (end - 6, 1), (end + 22, 2.4)], EASE_OUT)
forged.fade(chip_check, end + 8, 0, 4)
forged.pop(chip_bad, end + 10, start=1.3, dur=14, ease=EASE_OUT)
forged.key(proof_flash, OP, [(0, 0), (end + 10, 0), (end + 13, 1), (end + 50, 0)], EASE_OUT)
FORGED_LEN = end + 70

# ---------------------------------------------------------------- view model + machine
VM, VM_INST, P_FORGED = b.nid(), b.nid(), b.nid()
SM, LAYER, S_OK, S_BAD, A_OK, A_BAD, ART, ART_STYLE = (b.nid() for _ in range(8))

body = f"""
<Artboard defaultStateMachineId="{SM}" viewModelId="{VM}" viewModelInstanceId="{VM_INST}" styleId="{ART_STYLE}" width="{W}" height="{H}" x="0" y="700" name="Proof" id="{ART}">
<LayoutComponentStyle name="Proof Style" id="{ART_STYLE}"/>
{''.join(reversed(parts))}
<StateMachine name="Proof" id="{SM}">
  <StateMachineLayer name="Flow" id="{LAYER}">
    <EntryState x="0" y="0"><StateTransition stateToId="{S_OK}"/></EntryState>
    <AnyState x="160" y="-140"/>
    <ExitState x="480" y="-140"/>
    <AnimationState x="160" y="0" animationId="{A_OK}" reset="true" id="{S_OK}">
      <StateTransition stateToId="{S_BAD}">{bool_condition(VM, P_FORGED, True)}</StateTransition>
    </AnimationState>
    <AnimationState x="400" y="0" animationId="{A_BAD}" reset="true" id="{S_BAD}">
      <StateTransition stateToId="{S_OK}">{bool_condition(VM, P_FORGED, False)}</StateTransition>
    </AnimationState>
  </StateMachineLayer>
</StateMachine>
{verified.xml("Verified", A_OK, VERIFIED_LEN)}
{forged.xml("Rewrite caught", A_BAD, FORGED_LEN)}
</Artboard>
<ViewModel defaultInstanceId="{VM_INST}" name="Proof" id="{VM}">
  <ViewModelPropertyBoolean name="forged" id="{P_FORGED}"/>
  <ViewModelInstance exports="true" name="Default" id="{VM_INST}">
    <ViewModelInstanceBoolean propertyValue="false" viewModelPropertyId="{P_FORGED}"/>
  </ViewModelInstance>
</ViewModel>
"""

write("proof", body)
