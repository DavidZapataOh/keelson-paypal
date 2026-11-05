"""How-it-works artboards: one small looping scene per step.

- StepSign: the mandate is written line by line, a passkey is scanned, and the
  mandate is sealed.
- StepCheck: the mandate and the cart sit side by side and are compared field
  by field; every field ties off and the cart is cleared.
- StepPay: the countersignature closes on the mandate (the Split K) and the
  PayPal order goes out with the Alibi in its custom_id.
"""

from rml import (
    BACK, BONE, BONE2, EASE_IO, EASE_OUT, GRAPHITE, LINE, OK, OP, SANS, SX, SY, TEXT2, TRIM_END,
    VERMILION, WHITE, X, Y, Builder, Timeline, write,
)

W, H = 360, 220
HOLD_END = 70  # frames the finished pose holds before the loop fades out


def artboard(b, name, x, parts, tl, length):
    sm, layer, s, a, art, st = (b.nid() for _ in range(6))
    return f"""
<Artboard defaultStateMachineId="{sm}" styleId="{st}" width="{W}" height="{H}" x="{x}" y="1400" name="{name}" id="{art}">
<LayoutComponentStyle name="{name} Style" id="{st}"/>
{''.join(reversed(parts))}
<StateMachine name="Loop" id="{sm}">
  <StateMachineLayer name="Flow" id="{layer}">
    <EntryState x="0" y="0"><StateTransition stateToId="{s}"/></EntryState>
    <AnyState x="160" y="-140"/>
    <ExitState x="480" y="-140"/>
    <AnimationState x="160" y="0" animationId="{a}" id="{s}"/>
  </StateMachineLayer>
</StateMachine>
{tl.xml(name, a, length, loop="loop")}
</Artboard>"""


def fade_all(tl, objs, end):
    """Every listed object fades out together at the end so the loop restarts clean."""
    for obj in objs:
        key = (obj, OP)
        if key in tl.tracks:
            frames = tl.tracks[key]
            last = frames[-1][1]
            frames += [(end - 16, last, None), (end - 4, 0, EASE_OUT)]


# ===================================================================== Sign
b = Builder(7000)
parts = []
add = parts.append
add(b.rect(126, 110, 200, 168, r=12, fill=WHITE, stroke=GRAPHITE, name="Mandate")[1])
add(b.text(42, 44, "MANDATE", 10, TEXT2, 500)[1])
add(b.rect(126, 60, 200, 1, fill=LINE)[1])

LINES = [("SHOES", 82), ("SIZE 10", 106), ("MAX $100", 130), ("BY FRIDAY", 154)]
line_ids = []
for label, y in LINES:
    tid, xml = b.text(42, y, label, 12.5, GRAPHITE, 500, opacity=0)
    add(xml)
    line_ids.append((tid, y))

# the passkey: a fingerprint drawn arc by arc
ARCS = [10, 18, 26, 34]
arc_trims = []
fp_parts = [b.ellipse(0, 0, 84, fill=BONE, stroke=GRAPHITE, thick=1.5)[1]]
for r in ARCS:
    tid = b.nid()
    fp_parts.append(
        f'<Shape name="Arc {r}"><Ellipse width="{r * 2 - 14}" height="{r * 2}" name="Path"/>'
        f'{b.paint(stroke=GRAPHITE, thick=2, trim=(tid, 0.08, 0.08))}</Shape>'
    )
    arc_trims.append(tid)
fp, xml = b.node(286, 100, fp_parts, name="Passkey")
add(xml)
fp_ring, xml = b.ellipse(286, 100, 84, stroke=VERMILION, thick=2.5, opacity=0, name="Passkey ring")
add(xml)

seal, xml = b.node(
    286,
    166,
    [b.rect(0, 0, 112, 24, r=4, fill=GRAPHITE)[1], b.text(0, 0, "SIGNED", 10.5, BONE, 600, ox=0.5)[1]],
    opacity=0,
    name="Signed",
)
add(xml)
fp_label, xml = b.text(286, 166, "PASSKEY", 9.5, TEXT2, 500, ox=0.5)
add(xml)

D = {}
for tid, y in line_ids:
    D[(tid, OP)] = 0
    D[(tid, Y)] = y + 8
for t in arc_trims:
    D[(t, TRIM_END)] = 0.08
D[(fp_ring, OP)] = 0
D[(fp_ring, SX)] = D[(fp_ring, SY)] = 1
D[(seal, OP)] = 0
D[(seal, SX)] = D[(seal, SY)] = 1
D[(fp_label, OP)] = 1

tl = Timeline(D)
for i, (tid, y) in enumerate(line_ids):
    at = 10 + i * 12
    tl.key(tid, OP, [(0, 0), (at, 0), (at + 10, 1)], EASE_OUT)
    tl.key(tid, Y, [(0, y + 8), (at, y + 8), (at + 14, y)], EASE_OUT)
for i, t in enumerate(arc_trims):
    at = 70 + i * 7
    tl.key(t, TRIM_END, [(0, 0.08), (at, 0.08), (at + 22, 0.92)], EASE_IO)
tl.key(fp_ring, OP, [(0, 0), (104, 0), (106, 1), (132, 0)])
tl.key(fp_ring, SX, [(0, 1), (104, 1), (132, 1.45)], EASE_OUT)
tl.key(fp_ring, SY, [(0, 1), (104, 1), (132, 1.45)], EASE_OUT)
tl.fade(fp_label, 106, 0, 6)
tl.pop(seal, 110, start=0.8, dur=16)
SIGN_LEN = 130 + HOLD_END + 20
fade_all(tl, [t for t, _ in line_ids] + [seal], SIGN_LEN)
tl.tracks[(fp_label, OP)] += [(SIGN_LEN - 16, 0, None), (SIGN_LEN - 4, 1, EASE_OUT)]
for t in arc_trims:
    tl.tracks[(t, TRIM_END)] += [(SIGN_LEN - 16, 0.92, None), (SIGN_LEN - 4, 0.08, EASE_OUT)]
sign_xml = artboard(b, "StepSign", 2400, parts, tl, SIGN_LEN)

# ===================================================================== Check
b = Builder(8000)
parts = []
add = parts.append
FIELDS = [("SHOES", "SHOES", 82), ("SIZE 10", "SIZE 10", 106), ("≤ $100", "$94.00", 130), ("BY FRI", "THU", 154)]
for cx, title in ((84, "MANDATE"), (276, "CART")):
    add(b.rect(cx, 110, 136, 168, r=12, fill=WHITE, stroke=GRAPHITE, name=title)[1])
    add(b.text(cx - 54, 44, title, 10, TEXT2, 500)[1])
    add(b.rect(cx, 60, 136, 1, fill=LINE)[1])
for left, right, y in FIELDS:
    add(b.text(30, y, left, 12, GRAPHITE, 500)[1])
    add(b.text(222, y, right, 12, GRAPHITE, 500)[1])

links = []
for _, _, y in FIELDS:
    base = b.line(152, y, 208, y, stroke=LINE, thick=1.5, dash=(3, 3))[1]
    add(base)
    tid = b.nid()
    add(b.line(152, y, 208, y, stroke=OK, thick=2, trim=(tid, 0, 0))[1])
    tick, xml = b.node(
        180,
        y,
        [b.rect(0, 0, 16, 16, r=3, fill=OK)[1], b.check_mark(BONE, 0.85)],
        opacity=0,
        sx=0.4,
        sy=0.4,
    )
    add(xml)
    links.append((tid, tick))

cleared, xml = b.node(
    180,
    208,
    [b.rect(0, 0, 176, 24, r=4, fill=OK)[1], b.text(0, 0, "INSIDE THE MANDATE", 10.5, BONE, 600, ox=0.5)[1]],
    opacity=0,
    name="Cleared",
)
add(xml)

D = {(cleared, OP): 0, (cleared, SX): 1, (cleared, SY): 1}
for tid, tick in links:
    D[(tid, TRIM_END)] = 0
    D[(tick, OP)] = 0
    D[(tick, SX)] = D[(tick, SY)] = 0.4
tl = Timeline(D)
for i, (tid, tick) in enumerate(links):
    at = 16 + i * 17
    tl.key(tid, TRIM_END, [(0, 0), (at, 0), (at + 14, 1)], EASE_OUT)
    tl.pop(tick, at + 10, dur=16)
tl.pop(cleared, 96, start=0.85, dur=16)
CHECK_LEN = 112 + HOLD_END + 20
fade_all(tl, [tick for _, tick in links] + [cleared], CHECK_LEN)
for tid, _ in links:
    tl.tracks[(tid, TRIM_END)] += [(CHECK_LEN - 16, 1, None), (CHECK_LEN - 4, 0, EASE_OUT)]
check_xml = artboard(b, "StepCheck", 2800, parts, tl, CHECK_LEN)

# ===================================================================== Pay
b = Builder(9000)
parts = []
add = parts.append
chev = b.nid()
k, xml = b.node(
    70,
    96,
    [
        b.rect(0, 0, 22, 76, ox=0, fill=GRAPHITE, name="Stem")[1],
        b.poly([(19, -38), (47, -38), (24, 0), (47, 38), (19, 38), (-4, 0)], x=64, sid=chev, fill=VERMILION, name="Chevron")[1],
    ],
    name="Split K",
)
add(xml)
k_ring, xml = b.ellipse(98, 96, 96, stroke=VERMILION, thick=2.5, opacity=0, name="K ring")
add(xml)
k_hint, xml = b.text(98, 156, "MANDATE", 9.5, TEXT2, 500, ox=0.5)
add(xml)
k_label, xml = b.text(98, 156, "COUNTERSIGNED", 9.5, VERMILION, 600, ox=0.5, opacity=0)
add(xml)

order, xml = b.node(
    256,
    104,
    [
        b.rect(0, 0, 172, 124, r=12, fill=WHITE, stroke=GRAPHITE)[1],
        b.text(-70, -42, "PAYPAL ORDER", 10, TEXT2, 500)[1],
        b.text(-70, -16, "$94.00", 22, GRAPHITE, 600, font=SANS)[1],
        b.text(-70, 12, "custom_id", 9.5, TEXT2)[1],
        b.text(-70, 28, "kls_7f3c…a9d2", 11, GRAPHITE, 500)[1],
        b.rect(-70 + 46, 48, 92, 18, r=4, ox=0.5, fill=GRAPHITE)[1],
    ],
    opacity=0,
    name="Order",
)
add(xml)
captured, xml = b.text(256 - 70 + 46, 152, "CAPTURED", 9.5, BONE, 600, ox=0.5, opacity=0)
add(xml)
arrow_trim = b.nid()
add(b.line(140, 96, 166, 96, stroke=GRAPHITE, thick=1.5, trim=(arrow_trim, 0, 0))[1])

D = {(k_hint, OP): 1, (chev, X): 64, (k_ring, OP): 0, (k_ring, SX): 1, (k_ring, SY): 1, (k_label, OP): 0,
     (order, OP): 0, (order, X): 276, (captured, OP): 0, (arrow_trim, TRIM_END): 0}
tl = Timeline(D)
tl.key(chev, X, [(0, 64), (14, 64), (44, 30)], EASE_OUT)
tl.key(k_ring, OP, [(0, 0), (42, 0), (44, 0.9), (70, 0)])
tl.key(k_ring, SX, [(0, 1), (42, 1), (70, 1.5)], EASE_OUT)
tl.key(k_ring, SY, [(0, 1), (42, 1), (70, 1.5)], EASE_OUT)
tl.key(k_hint, OP, [(0, 1), (40, 1), (46, 0)])
tl.key(k_label, OP, [(0, 0), (46, 0), (56, 1)], EASE_OUT)
tl.key(arrow_trim, TRIM_END, [(0, 0), (56, 0), (70, 1)], EASE_OUT)
tl.key(order, OP, [(0, 0), (64, 0), (76, 1)], EASE_OUT)
tl.key(order, X, [(0, 276), (64, 276), (84, 256)], EASE_OUT)
tl.key(captured, OP, [(0, 0), (96, 0), (102, 1)])
PAY_LEN = 104 + HOLD_END + 20
fade_all(tl, [k_label, order, captured], PAY_LEN)
tl.tracks[(chev, X)] += [(PAY_LEN - 16, 30, None), (PAY_LEN - 2, 64, EASE_IO)]
tl.tracks[(k_hint, OP)] += [(PAY_LEN - 16, 0, None), (PAY_LEN - 4, 1, EASE_OUT)]
tl.tracks[(arrow_trim, TRIM_END)] += [(PAY_LEN - 16, 1, None), (PAY_LEN - 4, 0, EASE_OUT)]
pay_xml = artboard(b, "StepPay", 3200, parts, tl, PAY_LEN)

write("steps", sign_xml + check_xml + pay_xml)
