"""Proof artboards: a rewrite of the record, caught. Wide (Proof) and tall
(ProofMobile, the two panels stacked).

One panel is the transparency log of one order; the other is the inclusion
proof, where the log's entries hash up a Merkle tree to a root that is
compared against the checkpoint published on-chain at the time.

- Verified (`forged` false): the proof walks up from the countersignature
  entry and the computed root matches the published checkpoint.
- Forged (`forged` true): the log's operator rewrites entry #1203 to say the
  user approved $340 and re-signs it. The signature still checks out. The
  changed leaf changes every hash on its way up, the root no longer matches
  the checkpoint, and the rewrite is caught.
"""

from dataclasses import dataclass

from rml import (
    BONE, EASE_IO, EASE_OUT, GRAPHITE, LINE, OK, OP, SX, SY, TEXT2, TRIM_END, VERMILION,
    VERMILION_DEEP, WHITE, X, Y, Builder, Timeline, bool_condition, write,
)


@dataclass
class Layout:
    name: str
    id_start: int
    stage: tuple  # x, y on the editor stage
    w: int
    h: int
    log: tuple  # cx, cy, w, h of the log panel
    proof: tuple  # cx, cy, w, h of the proof panel
    entry_text: float  # size of entry text
    cursor_start: tuple
    cursor_exit: tuple


WIDE = Layout(name="Proof", id_start=3000, stage=(0, 700), w=760, h=460,
              log=(210, 230, 380, 420), proof=(585, 230, 330, 420), entry_text=13,
              cursor_start=(120, 520), cursor_exit=(520, 470))
TALL = Layout(name="ProofMobile", id_start=3600, stage=(900, 700), w=360, h=900,
              log=(180, 235, 328, 430), proof=(180, 675, 328, 410), entry_text=12,
              cursor_start=(60, 940), cursor_exit=(380, 470))

ENTRIES = [
    ("#1201", "MANDATE SIGNED · PASSKEY", "7b2e"),
    ("#1202", "CART CHECKED · INSIDE", "a1f3"),
    ("#1203", "COUNTERSIGNED · $94.00", "c7d2"),
    ("#1204", "CAPTURED · VIA PAYPAL", "5d80"),
]


def build(L: Layout) -> str:
    b = Builder(L.id_start)
    parts = []
    add = parts.append

    lcx, lcy, lw, lh = L.log
    pcx, pcy, pw, ph = L.proof
    ltop, ptop = lcy - lh / 2, pcy - ph / 2
    lx0, lx1 = lcx - lw / 2 + 20, lcx + lw / 2 - 20  # inner edges of the log
    px0, px1 = pcx - pw / 2 + 20, pcx + pw / 2 - 20

    # ------------------------------------------------------------ panels
    add(b.rect(lcx, lcy, lw, lh, r=14, fill=BONE, stroke=GRAPHITE, name="Log panel")[1])
    add(b.rect(pcx, pcy, pw, ph, r=14, fill=BONE, stroke=GRAPHITE, name="Proof panel")[1])
    proof_flash, xml = b.rect(pcx, pcy, pw, ph, r=14, stroke=VERMILION, thick=3, opacity=0, name="Proof flash")
    add(xml)

    add(b.text(lx0, ltop + 28, "TRANSPARENCY LOG", 12.5, GRAPHITE, 500)[1])
    add(b.text(lx1, ltop + 28, "ORDER 7RX-2214", 12.5, TEXT2, ox=1)[1])
    add(b.rect(lcx, ltop + 58, lw, 1.5, fill=GRAPHITE)[1])
    add(b.text(px0, ptop + 28, "INCLUSION PROOF", 12.5, GRAPHITE, 500)[1])
    add(b.rect(pcx, ptop + 58, pw, 1.5, fill=GRAPHITE)[1])

    # ------------------------------------------------------------ the log
    entry_w = lw - 40
    entry_y = [ltop + 92 + i * 58 for i in range(4)]
    idx_x, label_x, hash_x = lx0 + 16, lx0 + 70 - (6 if L.entry_text < 13 else 0), lx1 - 16
    for (idx, label, h), y in zip(ENTRIES, entry_y):
        add(b.rect(lcx, y, entry_w, 46, r=6, fill=WHITE, stroke=LINE, name=f"Entry {idx}")[1])
        add(b.text(idx_x, y, idx, 12 if L.entry_text >= 13 else 11, TEXT2)[1])
        if idx != "#1203":
            add(b.text(label_x, y, label, L.entry_text, GRAPHITE)[1])
            add(b.text(hash_x, y, h, 12 if L.entry_text >= 13 else 11, TEXT2, ox=1)[1])

    fy = entry_y[2]
    entry_flash, xml = b.rect(lcx, fy, entry_w, 46, r=6, stroke=VERMILION, thick=2, opacity=0, name="Entry flash")
    add(xml)
    entry_ok, xml = b.text(label_x, fy, "COUNTERSIGNED · $94.00", L.entry_text, GRAPHITE)
    add(xml)
    entry_bad, xml = b.text(label_x, fy, "USER APPROVED $340.00", L.entry_text, VERMILION_DEEP, 600, opacity=0)
    add(xml)
    hash_size = 12 if L.entry_text >= 13 else 11
    hash_ok, xml = b.text(hash_x, fy, "c7d2", hash_size, TEXT2, ox=1)
    add(xml)
    hash_bad, xml = b.text(hash_x, fy, "e91b", hash_size, VERMILION_DEEP, 600, ox=1, opacity=0)
    add(xml)

    # the signature row: it stays valid, which is the point
    sep_y = entry_y[3] + 36
    sig_y = sep_y + 30
    add(b.rect(lcx, sep_y, entry_w, 1, fill=LINE)[1])
    add(b.text(lx0, sig_y, "SIGNATURE", 12, TEXT2)[1])
    add(b.node(lx0 + 80, sig_y, [b.rect(0, 0, 16, 16, r=3, fill=OK)[1], b.check_mark(BONE, 0.9)], name="Sig tick")[1])
    add(b.text(lx0 + 96, sig_y, "VALID", 12, OK, 600)[1])
    wide = L.entry_text >= 13
    resigned, xml = b.text(
        lx0 + (146 if wide else 0),
        sig_y + (0 if wide else 24),
        "· RE-SIGNED BY THE OPERATOR" if wide else "RE-SIGNED BY THE OPERATOR",
        12 if wide else 11,
        TEXT2,
        opacity=0,
    )
    add(xml)
    add(b.text(lx0, ltop + lh - 30, "A SIGNED LOG ACCEPTS THE REWRITE.", 11 if wide else 10.5, TEXT2)[1])

    # ------------------------------------------------------------ the proof
    row1, row2 = ptop + 86, ptop + 112
    vx = px0 + 90
    add(b.text(px0, row1, "COMPUTED", 11.5, TEXT2)[1])
    add(b.text(px0, row2, "PUBLISHED", 11.5, TEXT2)[1])
    root_ok, xml = b.text(vx, row1, "9f3a…c21e", 13, GRAPHITE, 500)
    add(xml)
    root_bad, xml = b.text(vx, row1, "4c07…b88d", 13, VERMILION_DEEP, 600, opacity=0)
    add(xml)
    add(b.text(vx, row2, "9f3a…c21e", 13, GRAPHITE, 500)[1])
    add(b.text(px1, row2, "ON-CHAIN", 10.5, TEXT2, 500, ox=1)[1])

    span = px1 - px0
    root = (pcx, ptop + 168)
    mid = [(px0 + span * 0.25, ptop + 234), (px0 + span * 0.75, ptop + 234)]
    leaves = [(px0 + span * f, ptop + 300) for f in (0.08, 0.36, 0.64, 0.92)]
    edges = [(leaves[0], mid[0]), (leaves[1], mid[0]), (leaves[2], mid[1]), (leaves[3], mid[1]), (mid[0], root), (mid[1], root)]
    for a, c in edges:
        add(b.line(*a, *c, stroke=LINE, thick=2)[1])

    trims = {}
    for name, (a, c) in {"leaf": (leaves[2], mid[1]), "mid": (mid[1], root)}.items():
        for tone, color in (("ok", OK), ("bad", VERMILION)):
            tid = b.nid()
            add(b.line(*a, *c, stroke=color, thick=2.5, trim=(tid, 0, 0), name=f"Path {name} {tone}")[1])
            trims[(name, tone)] = tid

    def tree_node(x, y, d, label=None):
        add(b.ellipse(x, y, d, fill=BONE, stroke=GRAPHITE, thick=1.5)[1])
        if label:
            add(b.text(x, y + 24, label, 10.5, TEXT2, ox=0.5)[1])

    tree_node(*root, 22)
    for m in mid:
        tree_node(*m, 16)
    for (x, y), (idx, _, _) in zip(leaves, ENTRIES):
        tree_node(x, y, 14, idx)

    fills = {}
    for key, (x, y), d in (("leaf", leaves[2], 14), ("mid", mid[1], 16), ("root", root, 22)):
        for tone, color in (("ok", OK), ("bad", VERMILION)):
            sid, xml = b.ellipse(x, y, d, fill=color, opacity=0, name=f"Node {key} {tone}")
            add(xml)
            fills[(key, tone)] = sid

    root_ring, xml = b.ellipse(*root, 22, stroke=VERMILION, thick=2, opacity=0, name="Root ring")
    add(xml)

    chip_y = ptop + ph - 44

    def chip(label, width, bg, fg, border=None, opacity=0):
        cid, xml = b.node(
            pcx,
            chip_y,
            [b.rect(0, 0, width, 34, r=4, fill=bg, stroke=border)[1], b.text(0, 0, label, 12.5, fg, 600, ox=0.5)[1]],
            opacity=opacity,
            name=f"Chip {label}",
        )
        add(xml)
        return cid

    chip_check = chip("VERIFYING", 120, BONE, TEXT2, border=LINE, opacity=1)
    chip_ok = chip("MATCHES THE CHECKPOINT", 236, GRAPHITE, BONE)
    chip_bad = chip("REWRITE DETECTED · #1203", 252, VERMILION, GRAPHITE)

    ripple, ripple_xml = b.ellipse(0, 0, 30, stroke=VERMILION, thick=2, opacity=0, name="Ripple")
    cx0, cy0 = L.cursor_start
    cursor, xml = b.node(
        cx0,
        cy0,
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

    # ------------------------------------------------------------ timelines
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
    for obj, y in [(entry_ok, fy), (entry_bad, fy), (hash_ok, fy), (hash_bad, fy), (root_ok, row1), (root_bad, row1)]:
        D[(obj, Y)] = y
    D[(cursor, X)] = cx0
    D[(cursor, Y)] = cy0

    def walk(tl, tone, at):
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
    verified_len = end + 40

    target_x = label_x + 120
    ex, ey = L.cursor_exit
    forged = Timeline(D)
    forged.key(cursor, X, [(0, cx0), (30, target_x), (44, target_x), (74, ex)], EASE_IO)
    forged.key(cursor, Y, [(0, cy0), (30, fy + 8), (44, fy + 8), (74, ey)], EASE_IO)
    forged.key(ripple, OP, [(0, 0), (32, 0), (34, 1), (54, 0)])
    forged.key(ripple, SX, [(0, 0.3), (32, 0.3), (54, 1.7)], EASE_OUT)
    forged.key(ripple, SY, [(0, 0.3), (32, 0.3), (54, 1.7)], EASE_OUT)
    forged.key(entry_flash, OP, [(0, 0), (34, 0), (40, 1)], EASE_OUT)
    forged.slide_out(entry_ok, 36, fy).slide_in(entry_bad, 38, fy)
    forged.key(hash_ok, OP, [(0, 1), (50, 1), (54, 0)])
    forged.key(hash_bad, OP, [(0, 0), (54, 0), (56, 1), (59, 0.2), (62, 1), (65, 0.3), (68, 1)])
    forged.fade(resigned, 66, 1, 12)
    end = walk(forged, "bad", 80)
    forged.slide_out(root_ok, end - 4, row1, dist=8).slide_in(root_bad, end - 2, row1, dist=8)
    forged.key(root_ring, OP, [(0, 0), (end - 6, 0), (end - 4, 1), (end + 22, 0)])
    forged.key(root_ring, SX, [(0, 1), (end - 6, 1), (end + 22, 2.4)], EASE_OUT)
    forged.key(root_ring, SY, [(0, 1), (end - 6, 1), (end + 22, 2.4)], EASE_OUT)
    forged.fade(chip_check, end + 8, 0, 4)
    forged.pop(chip_bad, end + 10, start=1.3, dur=14, ease=EASE_OUT)
    forged.key(proof_flash, OP, [(0, 0), (end + 10, 0), (end + 13, 1), (end + 50, 0)], EASE_OUT)
    forged_len = end + 70

    # ------------------------------------------------------------ view model + machine
    vm, vm_inst, p_forged = b.nid(), b.nid(), b.nid()
    sm, layer, s_ok, s_bad, a_ok, a_bad, art, art_style = (b.nid() for _ in range(8))
    sx, sy = L.stage
    return f"""
<Artboard defaultStateMachineId="{sm}" viewModelId="{vm}" viewModelInstanceId="{vm_inst}" styleId="{art_style}" width="{L.w}" height="{L.h}" x="{sx}" y="{sy}" name="{L.name}" id="{art}">
<LayoutComponentStyle name="{L.name} Style" id="{art_style}"/>
{''.join(reversed(parts))}
<StateMachine name="Proof" id="{sm}">
  <StateMachineLayer name="Flow" id="{layer}">
    <EntryState x="0" y="0"><StateTransition stateToId="{s_ok}"/></EntryState>
    <AnyState x="160" y="-140"/>
    <ExitState x="480" y="-140"/>
    <AnimationState x="160" y="0" animationId="{a_ok}" reset="true" id="{s_ok}">
      <StateTransition stateToId="{s_bad}">{bool_condition(vm, p_forged, True)}</StateTransition>
    </AnimationState>
    <AnimationState x="400" y="0" animationId="{a_bad}" reset="true" id="{s_bad}">
      <StateTransition stateToId="{s_ok}">{bool_condition(vm, p_forged, False)}</StateTransition>
    </AnimationState>
  </StateMachineLayer>
</StateMachine>
{verified.xml("Verified", a_ok, verified_len)}
{forged.xml("Rewrite caught", a_bad, forged_len)}
</Artboard>
<ViewModel defaultInstanceId="{vm_inst}" name="{L.name}" id="{vm}">
  <ViewModelPropertyBoolean name="forged" id="{p_forged}"/>
  <ViewModelInstance exports="true" name="Default" id="{vm_inst}">
    <ViewModelInstanceBoolean propertyValue="false" viewModelPropertyId="{p_forged}"/>
  </ViewModelInstance>
</ViewModel>
"""


write("proof", build(WIDE) + build(TALL))
