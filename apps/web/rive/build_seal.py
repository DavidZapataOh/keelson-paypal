"""The seal: the Split K closes on a mandate once it can be signed.

A one-shot: the stem (the mandate) rises, the chevron (the countersign) slides in and closes the
gap, and a ring draws around them. Drawn without text so the lite runtime plays it on the card.

Run `python3 rive/build_seal.py && rive rive/seal --once` from apps/web, then copy the .riv into
public/rive.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "landing" / "rive" / "tools"))

from rml import BACK, BONE, EASE_IO, EASE_OUT, OP, SX, SY, TRIM_END, VERMILION, X, Builder, Timeline  # noqa: E402

OUT = Path(__file__).resolve().parent / "seal" / "scene.rml"
W = H = 160
C = 128
STEM = [(22.87, 16), (82.6, 16), (82.6, 240), (22.87, 240)]
CHEVRON = [(158.46, 16), (233.13, 16), (168.47, 128), (233.13, 240), (158.46, 240), (93.8, 128)]

b = Builder(50000)
stem_shape, stem_xml = b.poly([(x - C, y - C) for x, y in STEM], fill=BONE, name="Stem")
chev, chev_xml = b.poly([(x - C, y - C) for x, y in CHEVRON], fill=VERMILION, name="Chevron")
mark, mark_xml = b.node(W / 2, H / 2, [stem_xml, chev_xml], name="Split K", sx=0.34, sy=0.34)
ring_trim = b.nid()
_, ring_xml = b.ellipse(W / 2, H / 2, 140, stroke="59F2F0EA", thick=1.5, trim=(ring_trim, 0, 0), name="Ring")
halo, halo_xml = b.ellipse(W / 2, H / 2, 140, stroke=VERMILION, thick=2, opacity=0, name="Halo")
parts = [ring_xml, halo_xml, mark_xml]

D = {
    (stem_shape, SY): 0, (stem_shape, OP): 0,
    (chev, X): 70, (chev, OP): 0,
    (ring_trim, TRIM_END): 0,
    (halo, OP): 0, (halo, SX): 1, (halo, SY): 1,
}
tl = Timeline(D)
tl.key(stem_shape, OP, [(0, 0), (2, 1)])
tl.key(stem_shape, SY, [(0, 0), (16, 1)], EASE_OUT)
tl.key(chev, OP, [(0, 0), (12, 0), (16, 1)])
tl.key(chev, X, [(0, 70), (12, 70), (32, 0)], BACK)
tl.key(ring_trim, TRIM_END, [(0, 0), (20, 0), (50, 1)], EASE_IO)
tl.key(halo, OP, [(0, 0), (32, 0), (34, 0.9), (58, 0)])
tl.key(halo, SX, [(0, 1), (32, 1), (58, 1.25)], EASE_OUT)
tl.key(halo, SY, [(0, 1), (32, 1), (58, 1.25)], EASE_OUT)
LENGTH = 60

sm, layer, s, a, art, st = (b.nid() for _ in range(6))
xml = f"""
<Artboard defaultStateMachineId="{sm}" styleId="{st}" width="{W}" height="{H}" x="0" y="0" name="Seal" id="{art}">
<LayoutComponentStyle name="Seal Style" id="{st}"/>
{''.join(reversed(parts))}
<StateMachine name="Seal" id="{sm}">
  <StateMachineLayer name="Close" id="{layer}">
    <EntryState x="0" y="0"><StateTransition stateToId="{s}"/></EntryState>
    <AnyState x="160" y="-140"/>
    <ExitState x="480" y="-140"/>
    <AnimationState x="160" y="0" animationId="{a}" id="{s}"/>
  </StateMachineLayer>
</StateMachine>
{tl.xml("Close", a, LENGTH, loop="oneShot")}
</Artboard>"""

OUT.write_text(f'<Rive version="1" kind="fragment">\n{xml}\n</Rive>\n')
print(f"wrote {OUT}")
