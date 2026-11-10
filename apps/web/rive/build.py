"""The onboarding story as three looping artboards, drawn without text so the lite runtime plays
them; the app sets the words beside each one.

- Sign: a mandate fills in line by line, a passkey ring closes and the mandate is signed (the stem).
- Check: two carts meet the mandate; the one inside it is countersigned (the chevron closes), the
  one outside it is blocked before payment.
- Answer: the mandate's fields light up with who answers for each: Keelson (square), the agent's
  bond (diamond), you (dotted circle).

Run `python3 rive/build.py && rive rive/onboarding --once` from apps/web, then copy the .riv into
public/rive.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "landing" / "rive" / "tools"))

from rml import (  # noqa: E402
    BACK, BONE2, EASE_IO, EASE_OUT, GRAPHITE, LINE, OK, OP, SX, SY, TEXT2, TRIM_END, VERMILION,
    WARN, WHITE, X, Y, Builder, Timeline,
)

OUT = Path(__file__).resolve().parent / "onboarding" / "scene.rml"
W, H = 320, 220
HOLD = 80


def artboard(b, name, x, parts, tl, length):
    sm, layer, s, a, art, st = (b.nid() for _ in range(6))
    return f"""
<Artboard defaultStateMachineId="{sm}" styleId="{st}" width="{W}" height="{H}" x="{x}" y="0" name="{name}" id="{art}">
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


def fade_out(tl, objs, end):
    for obj in objs:
        frames = tl.tracks.get((obj, OP))
        if frames:
            frames += [(end - 16, frames[-1][1], None), (end - 4, 0, EASE_OUT)]


def split_k(b, x, y, chev_x, name="Split K", scale=1.0):
    chev = b.nid()
    stem = b.nid()
    nid, xml = b.node(
        x, y,
        [
            b.rect(0, 0, 18, 64, ox=0, sid=stem, fill=GRAPHITE, name="Stem")[1],
            b.poly([(16, -32), (40, -32), (20, 0), (40, 32), (16, 32), (-4, 0)], x=chev_x, sid=chev,
                   fill=VERMILION, name="Chevron")[1],
        ],
        name=name, sx=scale, sy=scale,
    )
    return nid, stem, chev, xml


# ===================================================================== Sign
b = Builder(20000)
parts = []
card, xml = b.node(120, 110, [b.rect(0, 0, 168, 150, r=14, fill=WHITE, stroke=LINE, thick=1.5)[1]], name="Card")
parts.append(xml)
lines = []
for i, w in enumerate([112, 84, 128, 64]):
    tid = b.nid()
    parts.append(b.line(56, 62 + i * 24, 56 + w, 62 + i * 24, stroke=TEXT2 if i else GRAPHITE, thick=6 if i == 0 else 4,
                        trim=(tid, 0, 0))[1])
    lines.append(tid)
ring, xml = b.ellipse(256, 110, 72, stroke=VERMILION, thick=2.5, opacity=0, name="Passkey ring")
parts.append(xml)
ring_trim = b.nid()
parts.append(b.ellipse(256, 110, 72, stroke=GRAPHITE, thick=2, trim=(ring_trim, 0, 0), name="Passkey")[1])
_, stem, _, kxml = split_k(b, 226, 110, 26)
seal = b.nid()
parts.append(f'<Node x="0" y="0" opacity="0" name="Seal" id="{seal}">{kxml}</Node>')

D = {(ring, OP): 0, (ring, SX): 1, (ring, SY): 1, (ring_trim, TRIM_END): 0, (seal, OP): 0}
for t in lines:
    D[(t, TRIM_END)] = 0
tl = Timeline(D)
for i, t in enumerate(lines):
    tl.key(t, TRIM_END, [(0, 0), (8 + i * 10, 0), (22 + i * 10, 1)], EASE_OUT)
tl.key(ring_trim, TRIM_END, [(0, 0), (56, 0), (84, 1)], EASE_IO)
tl.key(ring, OP, [(0, 0), (84, 0), (86, 0.9), (110, 0)])
tl.key(ring, SX, [(0, 1), (84, 1), (110, 1.45)], EASE_OUT)
tl.key(ring, SY, [(0, 1), (84, 1), (110, 1.45)], EASE_OUT)
tl.key(seal, OP, [(0, 0), (90, 0), (102, 1)], EASE_OUT)
SIGN = 110 + HOLD
fade_out(tl, [seal], SIGN)
for t in lines:
    tl.tracks[(t, TRIM_END)] += [(SIGN - 16, 1, None), (SIGN - 4, 0, EASE_OUT)]
tl.tracks[(ring_trim, TRIM_END)] += [(SIGN - 16, 1, None), (SIGN - 4, 0, EASE_OUT)]
sign_xml = artboard(b, "Sign", 0, parts, tl, SIGN)

# ===================================================================== Check
b = Builder(30000)
parts = []
_, stem, chev, kxml = split_k(b, 30, 110, 52)
parts.append(kxml)


def cart(b, y, w, name):
    return b.node(0, y, [b.rect(0, 0, w, 40, r=8, fill=WHITE, stroke=GRAPHITE, thick=1.5)[1],
                         b.line(-w / 2 + 14, 0, -w / 2 + 14 + w * 0.45, 0, stroke=TEXT2, thick=4)[1]],
                  opacity=0, name=name)


good, xml = cart(b, 72, 92, "Cart inside")
parts.append(xml)
bad, xml = cart(b, 150, 124, "Cart outside")
parts.append(xml)
ok_mark, xml = b.node(288, 72, [b.rect(0, 0, 26, 26, r=4, fill=OK)[1], b.check_mark(WHITE, 1.2)], opacity=0, name="Passed")
parts.append(xml)
block, xml = b.node(296, 150, [b.rect(0, 0, 26, 26, r=2, fill=VERMILION)[1]], opacity=0, name="Blocked")
parts.append(xml)

D = {(good, OP): 0, (good, X): 340, (bad, OP): 0, (bad, X): 340, (chev, X): 52, (ok_mark, OP): 0,
     (ok_mark, SX): 0.4, (ok_mark, SY): 0.4, (block, OP): 0}
tl = Timeline(D)
tl.key(good, OP, [(0, 0), (6, 0), (16, 1)], EASE_OUT)
tl.key(good, X, [(0, 340), (6, 340), (40, 192)], EASE_IO)
tl.key(chev, X, [(0, 52), (34, 52), (50, 26), (66, 26), (78, 52)], EASE_OUT)
tl.pop(ok_mark, 46, dur=16, ease=BACK)
tl.key(bad, OP, [(0, 0), (70, 0), (80, 1)], EASE_OUT)
tl.key(bad, X, [(0, 340), (70, 340), (100, 210)], EASE_OUT)
tl.key(block, OP, [(0, 0), (100, 0), (102, 1)])
CHECK = 104 + HOLD
fade_out(tl, [good, bad, ok_mark, block], CHECK)
check_xml = artboard(b, "Check", 400, parts, tl, CHECK)

# ===================================================================== Answer
b = Builder(40000)
parts = []
parts.append(b.rect(160, 110, 260, 176, r=14, fill=WHITE, stroke=LINE, thick=1.5)[1])
rows = []
for i, kind in enumerate(["verified", "attested", "yours"]):
    y = 58 + i * 52
    parts.append(b.rect(160, y + 24, 228, 1, fill=BONE2)[1] if i < 2 else "")
    if kind == "verified":
        mark = [b.rect(0, 0, 18, 18, r=2, fill=OK)[1], b.check_mark(WHITE, 0.8)]
    elif kind == "attested":
        mark = [b.poly([(0, -11), (11, 0), (0, 11), (-11, 0)], stroke=WARN, thick=1.75, fill="26855A06")[1]]
    else:
        mark = [b.ellipse(0, 0, 18, stroke=TEXT2, thick=1.75, dash=(2.5, 2.5))[1]]
    nid, xml = b.node(56, y, mark, opacity=0.25, name=f"Mark {kind}")
    parts.append(xml)
    bar = b.nid()
    parts.append(b.line(80, y, 80 + [150, 120, 96][i], y, stroke=GRAPHITE if i == 0 else TEXT2, thick=5,
                        trim=(bar, 0, 0))[1])
    rows.append((nid, bar))

D = {}
for nid, bar in rows:
    D[(nid, OP)] = 0.25
    D[(nid, SX)] = D[(nid, SY)] = 1
    D[(bar, TRIM_END)] = 0
tl = Timeline(D)
for i, (nid, bar) in enumerate(rows):
    at = 10 + i * 26
    tl.key(bar, TRIM_END, [(0, 0), (at, 0), (at + 16, 1)], EASE_OUT)
    tl.key(nid, OP, [(0, 0.25), (at + 10, 0.25), (at + 16, 1)], EASE_OUT)
    tl.key(nid, SX, [(0, 1), (at + 10, 1), (at + 18, 1.25), (at + 28, 1)], EASE_OUT)
    tl.key(nid, SY, [(0, 1), (at + 10, 1), (at + 18, 1.25), (at + 28, 1)], EASE_OUT)
ANSWER = 96 + HOLD
for nid, bar in rows:
    tl.tracks[(nid, OP)] += [(ANSWER - 16, 1, None), (ANSWER - 4, 0.25, EASE_OUT)]
    tl.tracks[(bar, TRIM_END)] += [(ANSWER - 16, 1, None), (ANSWER - 4, 0, EASE_OUT)]
answer_xml = artboard(b, "Answer", 800, parts, tl, ANSWER)

OUT.write_text(f'<Rive version="1" kind="fragment">\n{sign_xml}{check_xml}{answer_xml}\n</Rive>\n')
print(f"wrote {OUT}")
