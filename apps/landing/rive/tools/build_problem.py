"""Problem artboard: the conversation nobody wins.

A shopping-agent chat. The user asks for running shoes, size 10, under $100.
The agent orders a pair for $94. A size 11 arrives. The agent says it ordered
what the listing showed, the store says the order matches the listing, and the
card rules say the cardholder answers for the agent. The user asks who pays,
the agent keeps typing, and the $94 lands on the user.

One looping timeline: messages arrive with typing indicators, the thread
scrolls as it grows, the loss lands, the scene holds, then fades and restarts.
"""

from rml import (
    BONE, BONE2, EASE_IO, EASE_OUT, GRAPHITE, LINE, OK, OP, SANS, SX, SY, TEXT2, VERMILION,
    VERMILION_DEEP, WHITE, X, Y, Builder, Timeline, write,
)

b = Builder(5000)
W, H = 560, 640
PX, PW = 20, 520  # panel x and width
TOP, BOTTOM = 96, 560  # visible thread area
L, R = 44, 516  # bubble edges
FPS = 60

parts = []
add = parts.append

# ---------------------------------------------------------------- frame
add(b.rect(W / 2, H / 2, PW, 600, r=18, fill=WHITE, stroke=GRAPHITE, name="Panel")[1])
add(b.ellipse(56, 58, 34, fill=GRAPHITE, name="Agent avatar")[1])
add(b.text(56, 58, "A", 15, BONE, 600, font=SANS, ox=0.5)[1])
add(b.text(84, 50, "Shopping agent", 15, GRAPHITE, 600, font=SANS)[1])
add(b.text(84, 70, "PAYS WITH YOUR CARD", 10.5, TEXT2, 500)[1])
add(b.rect(W / 2, 92, PW, 1.5, fill=GRAPHITE)[1])
add(b.rect(W / 2, 588, PW - 40, 40, r=20, fill=BONE, stroke=LINE, name="Composer")[1])
add(b.text(52, 588, "Message your agent", 13, TEXT2, font=SANS)[1])

mask, xml = b.rect(W / 2, (TOP + BOTTOM) / 2, PW - 4, BOTTOM - TOP, name="Thread mask")
add(xml)

# ---------------------------------------------------------------- the thread
thread_parts = []
tadd = thread_parts.append
appear = []  # (node id, frame, local y)
cursor_y = TOP + 18
frame = 30


def w_sans(s, size=14):
    return len(s) * size * 0.5


def bubble(lines, side, fill, fg, at, avatar=None, gap=14):
    """A message bubble. side: 'r' for the user, 'l' for the others."""
    global cursor_y
    width = max(w_sans(t) for t in lines) + 32
    height = 22 * len(lines) + 20
    x = R - width / 2 if side == "r" else L + 40 + width / 2
    children = [b.rect(0, 0, width, height, r=16, fill=fill, stroke=None if fill != WHITE else LINE)[1]]
    for i, t in enumerate(lines):
        children.append(b.text(-width / 2 + 16, -height / 2 + 21 + i * 22, t, 14, fg, font=SANS)[1])
    y = cursor_y + height / 2
    nid, xml = b.node(x, y, children, opacity=0, name=f"Msg {lines[0][:14]}")
    tadd(xml)
    appear.append((nid, at, y))
    if avatar:
        av_fill, av_fg, av_letter, outline = avatar
        aid, axml = b.node(
            L + 14,
            cursor_y + height - 14,
            [
                b.ellipse(0, 0, 28, fill=av_fill, stroke=GRAPHITE if outline else None)[1],
                b.text(0, 0, av_letter, 12, av_fg, 600, font=SANS, ox=0.5)[1],
            ],
            opacity=0,
            name=f"Avatar {av_letter}",
        )
        tadd(axml)
        appear.append((aid, at, cursor_y + height - 14))
    cursor_y += height + gap
    return y


def typing(at, until):
    """Three dots in a bubble, shown from `at` to `until`."""
    y = cursor_y + 18
    dots = [b.ellipse(-12 + i * 12, 0, 7, fill=TEXT2, sid=b.nid())[1] for i in range(3)]
    ids = [d.split('id="')[1].split('"')[0] for d in dots]
    nid, xml = b.node(L + 40 + 32, y, [b.rect(0, 0, 64, 36, r=16, fill=BONE2)[1], *dots], opacity=0, name="Typing")
    tadd(xml)
    typers.append((nid, at, until, ids))


typers = []
AGENT = (GRAPHITE, BONE, "A", False)
STORE = (WHITE, GRAPHITE, "S", True)

# 1. the ask
bubble(["Running shoes, size 10, under $100."], "r", GRAPHITE, BONE, frame)
frame += 40
typing(frame, frame + 50)
frame += 50
# 2. the order, with its card
bubble(["Found a pair for $94. Ordered."], "l", BONE2, GRAPHITE, frame, avatar=AGENT, gap=8)
card_y = cursor_y + 46
shoe = b.poly(
    [(-26, 8), (-24, -6), (-14, -8), (-6, -2), (8, 0), (22, 4), (26, 10), (24, 14), (-26, 14)],
    fill=GRAPHITE,
    name="Shoe",
)[1]
card_children = [
    b.rect(0, 0, 300, 84, r=12, fill=WHITE, stroke=LINE)[1],
    b.rect(-112, 0, 60, 60, r=8, fill=BONE2)[1],
    b.node(-112, 2, [shoe])[1],
    b.text(-70, -18, "Trail runner", 14, GRAPHITE, 600, font=SANS)[1],
    b.text(-70, 2, "US 10 · $94.00", 12, TEXT2)[1],
    b.rect(-70 + 56, 24, 112, 20, r=4, ox=0.5, fill=GRAPHITE)[1],
    b.text(-70 + 56, 24, "PAID · MON 09:14", 10, BONE, 600, ox=0.5)[1],
]
cid, xml = b.node(L + 40 + 150, card_y, card_children, opacity=0, name="Order card")
tadd(xml)
appear.append((cid, frame + 14, card_y))
cursor_y += 84 + 18
frame += 70

# 3. the wrong size arrives
bubble(["They sent a size 11."], "r", GRAPHITE, BONE, frame, gap=8)
label_y = cursor_y + 30
label_children = [
    b.rect(0, 0, 260, 56, r=10, fill=WHITE, stroke=VERMILION_DEEP, dash=(5, 4))[1],
    b.text(-114, -12, "DELIVERED · THU", 10.5, TEXT2, 500)[1],
    b.text(-114, 10, "ORDERED US 10", 12, GRAPHITE)[1],
    b.text(114, 10, "GOT US 11", 12, VERMILION_DEEP, 600, ox=1)[1],
]
lid, xml = b.node(R - 130, label_y, label_children, opacity=0, name="Delivery label")
tadd(xml)
appear.append((lid, frame + 12, label_y))
cursor_y += 56 + 18
frame += 60

# 4. everyone else is right
typing(frame, frame + 40)
frame += 40
bubble(["I ordered what the listing showed."], "l", BONE2, GRAPHITE, frame, avatar=AGENT)
frame += 50
bubble(["The order matches the listing."], "l", WHITE, GRAPHITE, frame, avatar=STORE)
frame += 50
rule_y = cursor_y + 14
rid, xml = b.node(
    W / 2,
    rule_y,
    [
        b.rect(0, 0, 420, 28, r=14, fill=BONE)[1],
        b.text(0, 0, "CARD RULES · THE CARDHOLDER ANSWERS FOR THE AGENT", 10, TEXT2, 500, ox=0.5)[1],
    ],
    opacity=0,
    name="Card rule",
)
tadd(xml)
appear.append((rid, frame, rule_y))
cursor_y += 28 + 16
frame += 50

# 5. who pays
bubble(["So who pays for this?"], "r", GRAPHITE, BONE, frame)
frame += 30
typing(frame, frame + 400)
LOSS_AT = frame + 60
END = LOSS_AT + 220

thread, xml = b.node(0, 0, thread_parts, name="Thread")
# clip the thread to the visible area
xml = xml.replace('name="Thread"', 'name="Thread"', 1)
xml = xml[: xml.rindex("</Node>")] + f'<ClippingShape sourceId="{mask}" name="Clip"/></Node>'
add(xml)

# the loss
loss, xml = b.node(
    W / 2,
    532,
    [
        b.rect(0, 0, PW - 40, 46, r=12, fill=VERMILION)[1],
        b.text(-(PW - 40) / 2 + 18, 0, "YOU CARRY THE LOSS", 12.5, GRAPHITE, 600)[1],
        b.text((PW - 40) / 2 - 18, 0, "−$94.00", 16, GRAPHITE, 600, ox=1)[1],
    ],
    opacity=0,
    name="Loss",
)
add(xml)

# ---------------------------------------------------------------- timeline
D = {}
for nid, _, y in appear:
    D[(nid, OP)] = 0
    D[(nid, Y)] = y + 10
for nid, _, _, ids in typers:
    D[(nid, OP)] = 0
    for d in ids:
        D[(d, Y)] = 0
D[(thread, Y)] = 0
D[(thread, OP)] = 1
D[(loss, OP)] = 0
D[(loss, Y)] = 560

tl = Timeline(D)
for nid, at, y in appear:
    tl.key(nid, OP, [(0, 0), (at, 0), (at + 10, 1), (END - 30, 1), (END - 10, 0)], EASE_OUT)
    tl.key(nid, Y, [(0, y + 10), (at, y + 10), (at + 16, y)], EASE_OUT)

for nid, at, until, ids in typers:
    tl.key(nid, OP, [(0, 0), (at, 0), (at + 6, 1), (until, 1), (until + 4, 0)])
    for i, d in enumerate(ids):
        frames = [(0, 0)]
        t = at + i * 6
        while t + 24 < until:
            frames += [(t, 0), (t + 8, -4), (t + 16, 0)]
            t += 30
        tl.key(d, Y, frames)

# scroll so the newest message stays in view
scroll = [(0, 0)]
for nid, at, y in sorted(appear, key=lambda a: a[1]):
    bottom = y + 60
    if bottom > BOTTOM - 70:
        target = -(bottom - (BOTTOM - 70))
        if target < scroll[-1][1]:
            scroll.append((at, scroll[-1][1]))
            scroll.append((at + 18, target))
scroll += [(END - 10, scroll[-1][1]), (END, 0)]
tl.key(thread, Y, scroll, EASE_IO)
tl.key(thread, OP, [(0, 1), (END - 30, 1), (END - 12, 0), (END, 1)])

tl.key(loss, OP, [(0, 0), (LOSS_AT, 0), (LOSS_AT + 10, 1), (END - 30, 1), (END - 10, 0)])
tl.key(loss, Y, [(0, 560), (LOSS_AT, 560), (LOSS_AT + 22, 532)], EASE_OUT)

# ---------------------------------------------------------------- machine
SM, LAYER, S, A, ART, ART_STYLE = (b.nid() for _ in range(6))
body = f"""
<Artboard defaultStateMachineId="{SM}" styleId="{ART_STYLE}" width="{W}" height="{H}" x="1600" y="0" name="Problem" id="{ART}">
<LayoutComponentStyle name="Problem Style" id="{ART_STYLE}"/>
{''.join(reversed(parts))}
<StateMachine name="Story" id="{SM}">
  <StateMachineLayer name="Flow" id="{LAYER}">
    <EntryState x="0" y="0"><StateTransition stateToId="{S}"/></EntryState>
    <AnyState x="160" y="-140"/>
    <ExitState x="480" y="-140"/>
    <AnimationState x="160" y="0" animationId="{A}" id="{S}"/>
  </StateMachineLayer>
</StateMachine>
{tl.xml("Conversation", A, END, loop="loop")}
</Artboard>
"""

write("problem", body)
print(f"conversation {END} frames ({END / FPS:.1f}s)")
