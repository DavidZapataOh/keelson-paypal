"""Closing artboard: the Split K closes.

Two vermilion bands grow in from the edges. In the gap between them the
Split K assembles: the stem (the mandate) drops into place and the chevron
(the countersignature) closes on it, with one ring. Plays once and holds.
"""

from rml import BACK, EASE_IO, EASE_OUT, GRAPHITE, OP, SX, SY, VERMILION, X, Y, Builder, Timeline, write

b = Builder(13000)
W, H = 1440, 200
CY = 100
BAND_H = 40
GAP_L, GAP_R = 620, 820  # the gap the K sits in
SLANT = 40

parts = []
add = parts.append

left, xml = b.node(
    0,
    CY,
    [b.poly([(0, -BAND_H / 2), (GAP_L - SLANT, -BAND_H / 2), (GAP_L, BAND_H / 2), (0, BAND_H / 2)], fill=VERMILION, name="Band left")[1]],
    sx=0,
    name="Left",
)
add(xml)
right, xml = b.node(
    W,
    CY,
    [b.poly([(-(W - GAP_R - SLANT), -BAND_H / 2), (0, -BAND_H / 2), (0, BAND_H / 2), (-(W - GAP_R), BAND_H / 2)], fill=VERMILION, name="Band right")[1]],
    sx=0,
    name="Right",
)
add(xml)

K_X = 676  # left edge of the stem; the closed K (stem + chevron) spans K_X..K_X+87, centered on the gap
stem, xml = b.rect(K_X, CY, 26, 92, ox=0, fill=GRAPHITE, opacity=0, name="Stem")
add(xml)
chev = b.nid()
add(b.poly([(23, -46), (57, -46), (29, 0), (57, 46), (23, 46), (-5, 0)], x=K_X + 120, y=CY, sid=chev, fill=VERMILION, opacity=0, name="Chevron")[1])
ring, xml = b.ellipse(K_X + 30, CY, 110, stroke=VERMILION, thick=2.5, opacity=0, name="Ring")
add(xml)

D = {(left, SX): 0, (right, SX): 0, (stem, OP): 0, (stem, Y): CY - 60, (chev, OP): 0, (chev, X): K_X + 120,
     (ring, OP): 0, (ring, SX): 1, (ring, SY): 1}
tl = Timeline(D)
tl.key(left, SX, [(0, 0), (6, 0), (46, 1)], EASE_OUT)
tl.key(right, SX, [(0, 0), (10, 0), (50, 1)], EASE_OUT)
tl.key(stem, OP, [(0, 0), (40, 0), (46, 1)])
tl.key(stem, Y, [(0, CY - 60), (40, CY - 60), (62, CY)], BACK)
tl.key(chev, OP, [(0, 0), (52, 0), (58, 1)])
tl.key(chev, X, [(0, K_X + 120), (52, K_X + 120), (80, K_X + 30)], EASE_OUT)
tl.key(ring, OP, [(0, 0), (78, 0), (80, 1), (112, 0)])
tl.key(ring, SX, [(0, 1), (78, 1), (112, 1.9)], EASE_OUT)
tl.key(ring, SY, [(0, 1), (78, 1), (112, 1.9)], EASE_OUT)
END = 120

SM, LAYER, S, A, ART, ST = (b.nid() for _ in range(6))
body = f"""
<Artboard defaultStateMachineId="{SM}" styleId="{ST}" width="{W}" height="{H}" x="0" y="2600" name="Closing" id="{ART}">
<LayoutComponentStyle name="Closing Style" id="{ST}"/>
{''.join(reversed(parts))}
<StateMachine name="Once" id="{SM}">
  <StateMachineLayer name="Flow" id="{LAYER}">
    <EntryState x="0" y="0"><StateTransition stateToId="{S}"/></EntryState>
    <AnyState x="160" y="-140"/>
    <ExitState x="480" y="-140"/>
    <AnimationState x="160" y="0" animationId="{A}" id="{S}"/>
  </StateMachineLayer>
</StateMachine>
{tl.xml("Close", A, END)}
</Artboard>
"""
write("closing", body)
