"""Views artboard: the same purchase, seen by three parties.

Merchant, agent operator and dispute each get a window onto the order's Alibi.
Fields a party may not see are redaction bars. The loop: the windows fill in,
a claim is opened, and only the fields the dispute needs are opened in its
window, the last one naming the party at fault. Then the claim closes and the
bars seal again.
"""

from rml import (
    BACK, BONE, EASE_IO, EASE_OUT, GRAPHITE, LINE, OK, OP, SX, SY, TEXT2, VERMILION,
    VERMILION_DEEP, WARN, WHITE, X, Y, Builder, Timeline, write,
)

b = Builder(11000)
W, H = 1080, 430
WIN_W, WIN_H = 336, 392
CENTERS = [180, 540, 900]
TOP = 20

MANDATE = "shoes · size 10 · max $100"
ROWS = [
    ("WHAT THE USER SIGNED", [None, (MANDATE, GRAPHITE), ("open", MANDATE, GRAPHITE)]),
    ("PRICE INSIDE THE MANDATE", [("yes · checked by Keelson", OK)] * 3),
    ("WHO STATED THE SIZE", [None, ("operator · bonded", WARN), ("open", "operator · bonded", WARN)]),
    ("COUNTERSIGNED", [("Mon 09:14:07 UTC", GRAPHITE)] * 3),
    ("PARTY AT FAULT", [None, None, ("open", "operator · bond pays $94", VERMILION_DEEP)]),
]
VIEWS = [("MERCHANT", "Receives the order"), ("AGENT OPERATOR", "Placed the order"), ("DISPUTE", "A claim opens fields")]

parts = []
add = parts.append
row_groups = []  # (node id, window index, row index, y)
opens = []  # (bar id, flash id, value id, row index)

for wi, (cx, (name, note)) in enumerate(zip(CENTERS, VIEWS)):
    left = cx - WIN_W / 2 + 22
    right = cx + WIN_W / 2 - 22
    add(b.rect(cx, TOP + WIN_H / 2, WIN_W, WIN_H, r=14, fill=WHITE, stroke=GRAPHITE, name=f"Window {name}")[1])
    add(b.text(left, TOP + 30, name, 12.5, GRAPHITE, 600)[1])
    note_id, note_xml = b.text(right, TOP + 30, note, 10.5, TEXT2, ox=1)
    add(note_xml)
    if wi == 2:
        dispute_note = note_id
    add(b.rect(cx, TOP + 56, WIN_W, 1.5, fill=GRAPHITE)[1])
    for ri, (label, cells) in enumerate(ROWS):
        y = TOP + 92 + ri * 62
        cell = cells[wi]
        children = [b.text(left, -12, label, 10, TEXT2, 500)[1]]
        if ri < len(ROWS) - 1:
            children.append(b.rect(cx, 22, WIN_W - 44, 1, fill=LINE)[1])
        if cell is None:
            children.append(b.rect(left, 10, 210 - ri * 14, 16, ox=0, r=2, fill=GRAPHITE, name="Bar")[1])
        elif cell[0] == "open":
            _, text_value, color = cell
            vid, vxml = b.text(left, 10, text_value, 13, color, 600, opacity=0)
            fid, fxml = b.rect(left, 10, 230, 16, ox=0, r=2, fill=VERMILION, opacity=0, name="Flash")
            bid, bxml = b.rect(left + 230, 10, 230, 16, ox=1, r=2, fill=GRAPHITE, name="Seal bar")
            children += [fxml, vxml, bxml]
            opens.append((bid, fid, vid, ri))
        else:
            text_value, color = cell
            children.append(b.text(left, 10, text_value, 13, color, 500)[1])
        gid, gxml = b.node(0, y, children, opacity=0, name=f"Row {wi}.{ri}")
        # the row node only carries y; its children use artboard x
        add(gxml)
        row_groups.append((gid, wi, ri, y))

claim, xml = b.node(
    CENTERS[2] + WIN_W / 2 - 22 - 56,
    TOP + 30,
    [b.rect(0, 0, 112, 22, r=4, fill=VERMILION)[1], b.text(0, 0, "CLAIM OPENED", 10, GRAPHITE, 600, ox=0.5)[1]],
    opacity=0,
    name="Claim",
)
add(xml)
win_flash, xml = b.rect(CENTERS[2], TOP + WIN_H / 2, WIN_W, WIN_H, r=14, stroke=VERMILION, thick=3, opacity=0, name="Window flash")
add(xml)

# ---------------------------------------------------------------- timeline
D = {}
for gid, _, _, y in row_groups:
    D[(gid, OP)] = 0
    D[(gid, Y)] = y + 8
for bid, fid, vid, _ in opens:
    D[(bid, SX)] = 1
    D[(fid, OP)] = 0
    D[(vid, OP)] = 0
D[(claim, OP)] = 0
D[(claim, SX)] = D[(claim, SY)] = 1
D[(win_flash, OP)] = 0
D[(dispute_note, OP)] = 1

tl = Timeline(D)
for gid, wi, ri, y in row_groups:
    at = 8 + wi * 10 + ri * 6
    tl.key(gid, OP, [(0, 0), (at, 0), (at + 12, 1)], EASE_OUT)
    tl.key(gid, Y, [(0, y + 8), (at, y + 8), (at + 18, y)], EASE_OUT)

CLAIM = 130
tl.key(dispute_note, OP, [(0, 1), (CLAIM - 6, 1), (CLAIM, 0)])
tl.pop(claim, CLAIM, start=1.3, dur=14, ease=EASE_OUT)
tl.key(win_flash, OP, [(0, 0), (CLAIM, 0), (CLAIM + 3, 1), (CLAIM + 40, 0)], EASE_OUT)
for k, (bid, fid, vid, ri) in enumerate(opens):
    at = CLAIM + 26 + k * 26
    tl.key(bid, SX, [(0, 1), (at, 1), (at + 18, 0)], EASE_IO)
    tl.key(fid, OP, [(0, 0), (at + 10, 0), (at + 14, 1), (at + 30, 0)], EASE_OUT)
    tl.key(vid, OP, [(0, 0), (at + 12, 0), (at + 22, 1)], EASE_OUT)

HOLD = CLAIM + 26 + len(opens) * 26 + 120
END = HOLD + 40
# the claim closes: bars seal again, rows stay
tl.tracks[(claim, OP)] += [(HOLD, 1, None), (HOLD + 12, 0, EASE_OUT)]
tl.tracks[(dispute_note, OP)] += [(HOLD + 12, 0, None), (HOLD + 22, 1, EASE_OUT)]
for bid, fid, vid, _ in opens:
    tl.tracks[(bid, SX)] += [(HOLD + 6, 0, None), (HOLD + 26, 1, EASE_IO)]
    tl.tracks[(vid, OP)] += [(HOLD + 6, 1, None), (HOLD + 14, 0, EASE_OUT)]
for gid, _, _, y in row_groups:
    tl.tracks[(gid, OP)] += [(END - 2, 1, None)]

# loop from the sealed pose, not from empty windows: the loop restarts at the claim
SM, LAYER, S_IN, S_LOOP, A_IN, A_LOOP, ART, ST = (b.nid() for _ in range(8))

loop = Timeline({})
# a second timeline for the repeat: rows already in, claim and opening again
for gid, _, _, y in row_groups:
    loop.key(gid, OP, [(0, 1)])
    loop.key(gid, Y, [(0, y)])
LOOP_CLAIM = 40
loop.key(claim, OP, [(0, 0), (LOOP_CLAIM, 0), (LOOP_CLAIM + 6, 1), (LOOP_CLAIM + 26 + len(opens) * 26 + 120, 1), (LOOP_CLAIM + 26 + len(opens) * 26 + 132, 0)])
loop.key(claim, SX, [(0, 1.3), (LOOP_CLAIM, 1.3), (LOOP_CLAIM + 14, 1)], EASE_OUT)
loop.key(claim, SY, [(0, 1.3), (LOOP_CLAIM, 1.3), (LOOP_CLAIM + 14, 1)], EASE_OUT)
_hold = LOOP_CLAIM + 26 + len(opens) * 26 + 120
loop.key(dispute_note, OP, [(0, 1), (LOOP_CLAIM - 6, 1), (LOOP_CLAIM, 0), (_hold + 12, 0), (_hold + 22, 1)])
loop.key(win_flash, OP, [(0, 0), (LOOP_CLAIM, 0), (LOOP_CLAIM + 3, 1), (LOOP_CLAIM + 40, 0)], EASE_OUT)
for k, (bid, fid, vid, ri) in enumerate(opens):
    at = LOOP_CLAIM + 26 + k * 26
    hold = LOOP_CLAIM + 26 + len(opens) * 26 + 120
    loop.key(bid, SX, [(0, 1), (at, 1), (at + 18, 0), (hold + 6, 0), (hold + 26, 1)], EASE_IO)
    loop.key(fid, OP, [(0, 0), (at + 10, 0), (at + 14, 1), (at + 30, 0)], EASE_OUT)
    loop.key(vid, OP, [(0, 0), (at + 12, 0), (at + 22, 1), (hold + 6, 1), (hold + 14, 0)], EASE_OUT)
LOOP_END = LOOP_CLAIM + 26 + len(opens) * 26 + 120 + 60

body = f"""
<Artboard defaultStateMachineId="{SM}" styleId="{ST}" width="{W}" height="{H}" x="0" y="2000" name="Views" id="{ART}">
<LayoutComponentStyle name="Views Style" id="{ST}"/>
{''.join(reversed(parts))}
<StateMachine name="Loop" id="{SM}">
  <StateMachineLayer name="Flow" id="{LAYER}">
    <EntryState x="0" y="0"><StateTransition stateToId="{S_IN}"/></EntryState>
    <AnyState x="160" y="-140"/>
    <ExitState x="640" y="-140"/>
    <AnimationState x="160" y="0" animationId="{A_IN}" id="{S_IN}">
      <StateTransition stateToId="{S_LOOP}" enableExitTime="true" exitTimeIsPercetange="true" exitTime="100"/>
    </AnimationState>
    <AnimationState x="400" y="0" animationId="{A_LOOP}" id="{S_LOOP}"/>
  </StateMachineLayer>
</StateMachine>
{tl.xml("Views intro", A_IN, END)}
{loop.xml("Views claim", A_LOOP, LOOP_END, loop="loop")}
</Artboard>
"""

write("views", body)
print(f"intro {END}f, loop {LOOP_END}f")
