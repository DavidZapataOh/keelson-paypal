"""The app's state moments as one-shot artboards, drawn without text so the lite runtime plays
them; the app sets the words beside each one.

- Seal: the Split K closes on a mandate once it can be signed.
- Passkey: the passkey's arcs draw in, a ring closes around them and the stem takes their place.
- Live: the sealed card slides into its slot and a vermilion dot starts to beat.
- Blocked: a cart meets the mandate's stem and stops at the gap; the block lands beside it.
- Refund: the amount travels back along a line into the card and a check lands.

Run `python3 rive/build_states.py && rive rive/states --once` from apps/web, then copy the .riv
into public/rive.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "landing" / "rive" / "tools"))

from rml import (  # noqa: E402
    BACK, BONE, BONE2, EASE_IO, EASE_OUT, GRAPHITE, OK, OP, SX, SY, TEXT2, TRIM_END, VERMILION,
    WHITE, X, Y, Builder, Timeline,
)

OUT = Path(__file__).resolve().parent / "states" / "scene.rml"
W = H = 160
C = 128
STEM = [(22.87, 16), (82.6, 16), (82.6, 240), (22.87, 240)]
CHEVRON = [(158.46, 16), (233.13, 16), (168.47, 128), (233.13, 240), (158.46, 240), (93.8, 128)]


def artboard(b, name, x, parts, tl, length):
    sm, layer, s, a, art, st = (b.nid() for _ in range(6))
    return f"""
<Artboard defaultStateMachineId="{sm}" styleId="{st}" width="{W}" height="{H}" x="{x}" y="0" name="{name}" id="{art}">
<LayoutComponentStyle name="{name} Style" id="{st}"/>
{''.join(reversed(parts))}
<StateMachine name="Play" id="{sm}">
  <StateMachineLayer name="Once" id="{layer}">
    <EntryState x="0" y="0"><StateTransition stateToId="{s}"/></EntryState>
    <AnyState x="160" y="-140"/>
    <ExitState x="480" y="-140"/>
    <AnimationState x="160" y="0" animationId="{a}" id="{s}"/>
  </StateMachineLayer>
</StateMachine>
{tl.xml(name, a, length, loop="oneShot")}
</Artboard>"""


def split_k(b, x, y, scale, stem_fill=BONE):
    stem, stem_xml = b.poly([(px - C, py - C) for px, py in STEM], fill=stem_fill, name="Stem")
    chev, chev_xml = b.poly([(px - C, py - C) for px, py in CHEVRON], fill=VERMILION, name="Chevron")
    node, xml = b.node(x, y, [stem_xml, chev_xml], name="Split K", sx=scale, sy=scale)
    return node, stem, chev, xml


# ===================================================================== Seal
b = Builder(50000)
_, stem, chev, mark_xml = split_k(b, W / 2, H / 2, 0.34)
ring_trim = b.nid()
_, ring_xml = b.ellipse(W / 2, H / 2, 140, stroke="59F2F0EA", thick=1.5, trim=(ring_trim, 0, 0), name="Ring")
halo, halo_xml = b.ellipse(W / 2, H / 2, 140, stroke=VERMILION, thick=2, opacity=0, name="Halo")
tl = Timeline({
    (stem, SY): 0, (stem, OP): 0, (chev, X): 70, (chev, OP): 0, (ring_trim, TRIM_END): 0,
    (halo, OP): 0, (halo, SX): 1, (halo, SY): 1,
})
tl.key(stem, OP, [(0, 0), (2, 1)])
tl.key(stem, SY, [(0, 0), (16, 1)], EASE_OUT)
tl.key(chev, OP, [(0, 0), (12, 0), (16, 1)])
tl.key(chev, X, [(0, 70), (12, 70), (32, 0)], BACK)
tl.key(ring_trim, TRIM_END, [(0, 0), (20, 0), (50, 1)], EASE_IO)
tl.key(halo, OP, [(0, 0), (32, 0), (34, 0.9), (58, 0)])
tl.key(halo, SX, [(0, 1), (32, 1), (58, 1.25)], EASE_OUT)
tl.key(halo, SY, [(0, 1), (32, 1), (58, 1.25)], EASE_OUT)
seal_xml = artboard(b, "Seal", 0, [ring_xml, halo_xml, mark_xml], tl, 60)

# ===================================================================== Passkey
b = Builder(60000)
parts = []
arcs = []
for i, d in enumerate([28, 52, 76, 100]):
    tid = b.nid()
    parts.append(b.ellipse(W / 2, H / 2, d, stroke=GRAPHITE, thick=3, trim=(tid, 0, 0), name=f"Arc {i}")[1])
    arcs.append(tid)
ring_trim = b.nid()
parts.append(b.ellipse(W / 2, H / 2, 140, stroke=VERMILION, thick=2.5, trim=(ring_trim, 0, 0), name="Ring")[1])
arcs_node = b.nid()
parts = [f'<Node x="0" y="0" name="Arcs" id="{arcs_node}">{"".join(reversed(parts[:4]))}</Node>', parts[4]]
done, done_xml = b.node(W / 2, H / 2, [b.rect(0, 0, 44, 44, r=8, fill=OK)[1], b.check_mark(WHITE, 2.4)], opacity=0, name="Done")
parts.append(done_xml)
D = {(ring_trim, TRIM_END): 0, (arcs_node, OP): 1, (done, OP): 0, (done, SX): 0.4, (done, SY): 0.4}
for t in arcs:
    D[(t, TRIM_END)] = 0
tl = Timeline(D)
for i, t in enumerate(arcs):
    tl.key(t, TRIM_END, [(0, 0), (i * 6, 0), (i * 6 + 22, 0.72)], EASE_OUT)
tl.key(ring_trim, TRIM_END, [(0, 0), (30, 0), (60, 1)], EASE_IO)
tl.key(arcs_node, OP, [(0, 1), (60, 1), (68, 0)], EASE_OUT)
tl.pop(done, 64, dur=16, ease=BACK)
passkey_xml = artboard(b, "Passkey", 200, parts, tl, 84)

# ===================================================================== Live
b = Builder(70000)
slot, slot_xml = b.node(W / 2, 118, [b.rect(0, 0, 132, 24, r=12, fill=BONE2)[1]], name="Slot")
card, card_xml = b.node(W / 2, 40, [b.rect(0, 0, 112, 70, r=10, fill=GRAPHITE)[1]], name="Card")
_, _, _, k_xml = split_k(b, W / 2 - 38, 20, 0.07)
card_k, card_k_xml = b.node(0, 0, [k_xml], name="Card mark")
dot, dot_xml = b.ellipse(W / 2 + 40, 86, 10, fill=VERMILION, opacity=0, name="Dot")
beat, beat_xml = b.ellipse(W / 2 + 40, 86, 10, stroke=VERMILION, thick=2, opacity=0, name="Beat")
card_xml = card_xml.replace("</Node>", f"{card_k_xml}</Node>", 1)
tl = Timeline({(card, Y): 40, (card, OP): 0, (dot, OP): 0, (beat, OP): 0, (beat, SX): 1, (beat, SY): 1})
tl.key(card, OP, [(0, 0), (8, 1)])
tl.key(card, Y, [(0, 20), (26, 86)], EASE_OUT)
tl.key(dot, OP, [(0, 0), (28, 0), (32, 1)])
tl.key(beat, OP, [(0, 0), (32, 0), (34, 0.9), (60, 0)])
tl.key(beat, SX, [(0, 1), (32, 1), (60, 2.4)], EASE_OUT)
tl.key(beat, SY, [(0, 1), (32, 1), (60, 2.4)], EASE_OUT)
live_xml = artboard(b, "Live", 400, [slot_xml, card_xml, beat_xml, dot_xml], tl, 64)

# ===================================================================== Blocked
b = Builder(80000)
_, stem, chev, mark_xml = split_k(b, 44, H / 2, 0.3, stem_fill=GRAPHITE)
ticket, ticket_xml = b.node(200, H / 2, [
    b.rect(0, 0, 70, 34, r=8, fill=WHITE, stroke=GRAPHITE, thick=1.5)[1],
    b.line(-24, 0, 8, 0, stroke=TEXT2, thick=4)[1],
], opacity=0, name="Cart")
strike_trim = b.nid()
strike_xml = b.line(84, H / 2, 140, H / 2, stroke=VERMILION, thick=2, trim=(strike_trim, 0, 0))[1]
block, block_xml = b.node(112, H / 2 + 38, [b.rect(0, 0, 22, 22, r=3, fill=VERMILION)[1]], opacity=0, name="Block")
tl = Timeline({(ticket, X): 200, (ticket, OP): 0, (chev, X): 0, (strike_trim, TRIM_END): 0, (block, OP): 0, (block, SX): 0.4, (block, SY): 0.4})
tl.key(ticket, OP, [(0, 0), (6, 1)])
tl.key(ticket, X, [(0, 200), (30, 112)], EASE_OUT)
tl.key(chev, X, [(0, 0), (24, 0), (32, -26)], EASE_OUT)
tl.key(strike_trim, TRIM_END, [(0, 0), (34, 0), (44, 1)], EASE_OUT)
tl.pop(block, 40, dur=14, ease=BACK)
blocked_xml = artboard(b, "Blocked", 600, [mark_xml, ticket_xml, strike_xml, block_xml], tl, 60)

# ===================================================================== Refund
b = Builder(90000)
card, card_xml = b.node(W / 2, 112, [b.rect(0, 0, 112, 60, r=10, fill=GRAPHITE)[1]], name="Card")
path_trim = b.nid()
path_xml = b.line(W / 2, 20, W / 2, 80, stroke=TEXT2, thick=1.5, dash=(3, 4), trim=(path_trim, 0, 0))[1]
coin, coin_xml = b.ellipse(W / 2, 20, 18, fill=OK, opacity=0, name="Amount")
done, done_xml = b.node(W / 2, 112, [b.rect(0, 0, 28, 28, r=6, fill=OK)[1], b.check_mark(WHITE, 1.4)], opacity=0, name="Done")
tl = Timeline({(path_trim, TRIM_END): 0, (coin, OP): 0, (coin, Y): 20, (done, OP): 0, (done, SX): 0.4, (done, SY): 0.4})
tl.key(path_trim, TRIM_END, [(0, 0), (16, 1)], EASE_OUT)
tl.key(coin, OP, [(0, 0), (10, 1), (40, 1), (44, 0)])
tl.key(coin, Y, [(0, 20), (12, 20), (42, 104)], EASE_IO)
tl.pop(done, 42, dur=16, ease=BACK)
refund_xml = artboard(b, "Refund", 800, [card_xml, path_xml, coin_xml, done_xml], tl, 62)

OUT.parent.mkdir(exist_ok=True)
OUT.write_text(f'<Rive version="1" kind="fragment">\n{seal_xml}{passkey_xml}{live_xml}{blocked_xml}{refund_xml}\n</Rive>\n')
print(f"wrote {OUT}")
