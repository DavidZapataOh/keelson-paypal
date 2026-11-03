"""Hero artboard: an agent checkout card.

Two runs, chosen by the view model's `attacked` flag:

- Countersign: the agent picks the item, Keelson sweeps the cart against the
  mandate, every field checks out, the payment goes through and the Split K
  seal closes.
- Attack blocked: a page slides in pushing a $340 bundle, the agent falls for
  it, the sweep catches the total above the mandate, nothing is paid and the
  order is blocked.

An ambient layer keeps the "live" dot breathing in both.
"""

from rml import (
    BONE, EASE_IO, EASE_OUT, GRAPHITE, LINE, OK, OP, SANS, SX, SY, TEXT2, VERMILION,
    VERMILION_DEEP, WHITE, X, Y, Builder, Timeline, bool_condition, write,
)

b = Builder(1000)

W, H = 640, 470
CX = 300  # the card spans 20..580; the injected page pokes past it
LABEL_X, VALUE_X, TICK_X = 48, 196, 548
ROWS = {"mandate": 124, "cart": 176, "check": 228, "paid": 280, "status": 342}

parts = []
add = parts.append

# ---------------------------------------------------------------- the card
add(b.rect(CX, 215, 560, 390, r=14, fill=BONE, stroke=GRAPHITE, name="Card")[1])
flash, xml = b.rect(CX, 215, 560, 390, r=14, stroke=VERMILION, thick=3, opacity=0, name="Block flash")
add(xml)

live_ring, xml = b.ellipse(LABEL_X + 4, 48, 8, stroke=VERMILION, thick=1.5, opacity=0, name="Live ring")
add(xml)
add(b.ellipse(LABEL_X + 4, 48, 8, fill=VERMILION, name="Live dot")[1])
add(b.text(LABEL_X + 18, 48, "AGENT CHECKOUT", 12.5, GRAPHITE, 500)[1])
add(b.text(552, 48, "ORDER 7RX-2214", 12.5, TEXT2, ox=1)[1])
add(b.rect(CX, 78, 560, 1.5, fill=GRAPHITE)[1])

for y in (150, 202, 254, 306):
    add(b.rect(CX, y, 504, 1, fill=LINE)[1])

# the sweep sits behind the text, so it never reads as a strike-through
SCAN_TOP, SCAN_BOTTOM = 104, 300
scan, xml = b.node(
    CX,
    SCAN_TOP,
    [
        b.rect(0, -22, 504, 44, gradient={"sx": 0, "sy": -22, "ex": 0, "ey": 22,
                                          "stops": [("00FF4B1F", 0), ("29FF4B1F", 1)]}, name="Trail")[1],
        b.rect(0, 0, 504, 2, fill=VERMILION, name="Line")[1],
    ],
    opacity=0,
    name="Sweep",
)
add(xml)

for key, label in (("mandate", "MANDATE"), ("cart", "CART"), ("check", "CHECK"), ("paid", "PAID"), ("status", "STATUS")):
    add(b.text(LABEL_X, ROWS[key], label, 12.5, TEXT2)[1])

add(b.text(VALUE_X, ROWS["mandate"], "SHOES · SIZE 10 · MAX $100", 15, GRAPHITE)[1])


def value(row, label, color=GRAPHITE, weight=None, opacity=0):
    tid, xml = b.text(VALUE_X, ROWS[row], label, 15, color, weight, opacity=opacity)
    add(xml)
    return tid


cart_wait = value("cart", "—", TEXT2, opacity=1)
cart_ok = value("cart", "$94.00 · 1 PAIR · SIZE 10")
cart_bad = value("cart", "$340.00 · BUNDLE DEAL", weight=600)
check_wait = value("check", "WAITING FOR CART", TEXT2, opacity=1)
check_run = value("check", "CHECKING FIELD BY FIELD", TEXT2)
check_ok = value("check", "INSIDE THE MANDATE", OK, 600)
check_bad = value("check", "TOTAL EXCEEDS MAX $100", VERMILION_DEEP, 600)
paid_wait = value("paid", "—", TEXT2, opacity=1)
paid_ok = value("paid", "$94.00 · VIA PAYPAL")
paid_bad = value("paid", "$0.00 · NOTHING PAID", weight=600)


def tick(row, good=True):
    box = b.rect(0, 0, 18, 18, r=3, fill=OK if good else VERMILION)[1]
    mark = b.check_mark(BONE) if good else b.cross_mark(GRAPHITE)
    tid, xml = b.node(TICK_X, ROWS[row], [box, mark], opacity=0, sx=0.4, sy=0.4, name=f"Tick {row}")
    add(xml)
    return tid


tick_mandate = tick("mandate")
tick_cart_ok = tick("cart")
tick_cart_bad = tick("cart", good=False)

inj, xml = b.node(
    CX,
    ROWS["cart"],
    [
        b.rect(0, 0, 520, 40, r=6, stroke=VERMILION_DEEP, thick=1.5, dash=(6, 4))[1],
        b.text(246, -27, "INJECTED BY THE PAGE", 10.5, VERMILION_DEEP, 600, ox=1)[1],
    ],
    opacity=0,
    name="Injected",
)
add(xml)


def chip(label, width, bg, fg, border=None, opacity=0):
    cid, xml = b.node(
        VALUE_X + width / 2,
        ROWS["status"],
        [b.rect(0, 0, width, 32, r=4, fill=bg, stroke=border)[1], b.text(0, 0, label, 13, fg, 600, ox=0.5)[1]],
        opacity=opacity,
        name=f"Chip {label}",
    )
    add(xml)
    return cid


chip_wait = chip("PENDING", 104, BONE, TEXT2, border=LINE, opacity=1)
chip_ok = chip("COUNTERSIGNED", 164, GRAPHITE, BONE)
chip_bad = chip("BLOCKED", 108, VERMILION, GRAPHITE)

# Split K seal: the stem is the mandate, the chevron is the countersignature
chev = b.nid()
seal, xml = b.node(
    500,
    ROWS["status"],
    [
        b.rect(0, 0, 13, 44, ox=0, fill=GRAPHITE, name="Stem")[1],
        b.poly([(11, -22), (27, -22), (14, 0), (27, 22), (11, 22), (-2, 0)], x=52, sid=chev, name="Chevron", fill=VERMILION)[1],
    ],
    opacity=0,
    name="Seal",
)
add(xml)
seal_ring, xml = b.ellipse(522, ROWS["status"], 70, stroke=VERMILION, thick=2, opacity=0, name="Seal ring")
add(xml)

# the page that tries to hijack the agent
page, xml = b.node(
    760,
    124,
    [
        b.rect(0, 0, 232, 108, r=10, fill=WHITE, stroke=LINE)[1],
        b.text(-98, -32, "LIMITED TIME", 10, TEXT2, 500)[1],
        b.text(-98, -10, "Bundle deal", 17, GRAPHITE, 600, font=SANS)[1],
        b.text(98, -10, "$340", 17, VERMILION_DEEP, 600, font=SANS, ox=1)[1],
        b.rect(-52, 26, 92, 26, r=4, fill=GRAPHITE)[1],
        b.text(-52, 26, "ADD TO CART", 10, BONE, 600, ox=0.5)[1],
    ],
    rotation=-0.035,
    name="Injected page",
)
add(xml)

ripple, ripple_xml = b.ellipse(0, 0, 30, stroke=VERMILION, thick=2, opacity=0, name="Ripple")
cursor, xml = b.node(
    90,
    520,
    [
        ripple_xml,
        b.poly([(0, 0), (0, 23), (6, 17.5), (10.5, 27), (14.5, 25), (10, 16), (18, 16)],
               fill=GRAPHITE, stroke=BONE, thick=1.5, name="Arrow")[1],
        b.rect(22, 34, 56, 20, r=4, ox=0, fill=GRAPHITE)[1],
        b.text(50, 34, "AGENT", 10, BONE, 600, ox=0.5)[1],
    ],
    name="Agent cursor",
)
add(xml)

# ---------------------------------------------------------------- timelines
D = {}
for obj, v in [
    (cart_wait, 1), (cart_ok, 0), (cart_bad, 0), (inj, 0),
    (check_wait, 1), (check_run, 0), (check_ok, 0), (check_bad, 0),
    (paid_wait, 1), (paid_ok, 0), (paid_bad, 0),
    (chip_wait, 1), (chip_ok, 0), (chip_bad, 0),
    (seal, 0), (seal_ring, 0), (scan, 0), (flash, 0), (ripple, 0),
    (tick_mandate, 0), (tick_cart_ok, 0), (tick_cart_bad, 0),
]:
    D[(obj, OP)] = v
for obj in (tick_mandate, tick_cart_ok, tick_cart_bad):
    D[(obj, SX)] = D[(obj, SY)] = 0.4
for obj in (chip_ok, chip_bad, seal_ring):
    D[(obj, SX)] = D[(obj, SY)] = 1
D[(ripple, SX)] = D[(ripple, SY)] = 0.3
for obj, row in [(cart_ok, "cart"), (cart_bad, "cart"), (cart_wait, "cart"), (check_ok, "check"),
                 (check_bad, "check"), (paid_ok, "paid"), (paid_bad, "paid"), (paid_wait, "paid")]:
    D[(obj, Y)] = ROWS[row]
D[(scan, Y)] = SCAN_TOP
D[(chev, X)] = 52
D[(cursor, X)] = 90
D[(cursor, Y)] = 520
D[(page, X)] = 760


def sweep(tl, at, dur=64):
    tl.key(scan, OP, [(0, 0), (at, 0), (at + 6, 1), (at + dur, 1), (at + dur + 10, 0)])
    tl.key(scan, Y, [(0, SCAN_TOP), (at, SCAN_TOP), (at + dur, SCAN_BOTTOM)], EASE_IO)
    tl.fade(check_wait, at, 0, 6)
    tl.key(check_run, OP, [(0, 0), (at, 0), (at + 8, 1), (at + dur, 1), (at + dur + 6, 0)])
    return lambda y: at + dur * (y - SCAN_TOP) / (SCAN_BOTTOM - SCAN_TOP)


def click(tl, at):
    tl.key(ripple, OP, [(0, 0), (at, 0), (at + 2, 1), (at + 22, 0)])
    tl.key(ripple, SX, [(0, 0.3), (at, 0.3), (at + 22, 1.7)], EASE_OUT)
    tl.key(ripple, SY, [(0, 0.3), (at, 0.3), (at + 22, 1.7)], EASE_OUT)


ok = Timeline(D)
ok.key(cursor, X, [(0, 90), (34, 330), (52, 330), (84, 700)], EASE_IO)
ok.key(cursor, Y, [(0, 520), (34, 186), (52, 186), (84, 150)], EASE_IO)
click(ok, 36)
ok.slide_out(cart_wait, 38, ROWS["cart"]).slide_in(cart_ok, 40, ROWS["cart"])
cross = sweep(ok, 64)
ok.pop(tick_mandate, cross(ROWS["mandate"]))
ok.pop(tick_cart_ok, cross(ROWS["cart"]))
done = 128
ok.slide_in(check_ok, done + 2, ROWS["check"])
ok.slide_out(paid_wait, done + 10, ROWS["paid"]).slide_in(paid_ok, done + 12, ROWS["paid"])
ok.fade(chip_wait, done + 18, 0, 6)
ok.pop(chip_ok, done + 20, start=0.86, dur=16)
ok.key(seal, OP, [(0, 0), (done + 26, 0), (done + 30, 1)])
ok.key(chev, X, [(0, 52), (done + 26, 52), (done + 50, 16)], EASE_OUT)
ok.key(seal_ring, OP, [(0, 0), (done + 48, 0), (done + 50, 0.9), (done + 76, 0)])
ok.key(seal_ring, SX, [(0, 0.6), (done + 48, 0.6), (done + 76, 1.5)], EASE_OUT)
ok.key(seal_ring, SY, [(0, 0.6), (done + 48, 0.6), (done + 76, 1.5)], EASE_OUT)
OK_LEN = done + 90

bad = Timeline(D)
bad.key(page, X, [(0, 760), (8, 760), (34, 500), (100, 500), (122, 760)], EASE_OUT)
bad.key(cursor, X, [(0, 90), (30, 300), (52, 448), (70, 448), (96, 330), (112, 330), (140, 700)], EASE_IO)
bad.key(cursor, Y, [(0, 520), (30, 300), (52, 150), (70, 150), (96, 186), (112, 186), (140, 150)], EASE_IO)
click(bad, 56)
bad.slide_out(cart_wait, 98, ROWS["cart"]).slide_in(cart_bad, 100, ROWS["cart"])
bad.key(inj, OP, [(0, 0), (112, 0), (124, 1)], EASE_OUT)
cross = sweep(bad, 128)
bad.pop(tick_mandate, cross(ROWS["mandate"]))
bad.pop(tick_cart_bad, cross(ROWS["cart"]))
done = 192
bad.slide_in(check_bad, done + 2, ROWS["check"])
bad.slide_out(paid_wait, done + 10, ROWS["paid"]).slide_in(paid_bad, done + 12, ROWS["paid"])
bad.fade(chip_wait, done + 18, 0, 4)
bad.pop(chip_bad, done + 20, start=1.35, dur=14, ease=EASE_OUT)
bad.key(flash, OP, [(0, 0), (done + 20, 0), (done + 23, 1), (done + 60, 0)], EASE_OUT)
BAD_LEN = done + 80

amb = Timeline({})
amb.key(live_ring, OP, [(0, 0.8), (72, 0)])
amb.key(live_ring, SX, [(0, 1), (72, 2.6)], EASE_OUT)
amb.key(live_ring, SY, [(0, 1), (72, 2.6)], EASE_OUT)

# ---------------------------------------------------------------- view model + machine
VM, VM_INST, P_ATTACKED = b.nid(), b.nid(), b.nid()
SM, LAYER, AMB_LAYER, S_OK, S_BAD, S_AMB = (b.nid() for _ in range(6))
A_OK, A_BAD, A_AMB, ART, ART_STYLE = (b.nid() for _ in range(5))

body = f"""
<Artboard defaultStateMachineId="{SM}" viewModelId="{VM}" viewModelInstanceId="{VM_INST}" styleId="{ART_STYLE}" width="{W}" height="{H}" x="0" y="0" name="Hero" id="{ART}">
<LayoutComponentStyle name="Hero Style" id="{ART_STYLE}"/>
{''.join(reversed(parts))}
<StateMachine name="Checkout" id="{SM}">
  <StateMachineLayer name="Flow" id="{LAYER}">
    <EntryState x="0" y="0"><StateTransition stateToId="{S_OK}"/></EntryState>
    <AnyState x="160" y="-140"/>
    <ExitState x="480" y="-140"/>
    <AnimationState x="160" y="0" animationId="{A_OK}" reset="true" id="{S_OK}">
      <StateTransition stateToId="{S_BAD}">{bool_condition(VM, P_ATTACKED, True)}</StateTransition>
    </AnimationState>
    <AnimationState x="400" y="0" animationId="{A_BAD}" reset="true" id="{S_BAD}">
      <StateTransition stateToId="{S_OK}">{bool_condition(VM, P_ATTACKED, False)}</StateTransition>
    </AnimationState>
  </StateMachineLayer>
  <StateMachineLayer name="Ambient" id="{AMB_LAYER}">
    <EntryState x="0" y="200"><StateTransition stateToId="{S_AMB}"/></EntryState>
    <AnyState x="160" y="60"/>
    <ExitState x="480" y="60"/>
    <AnimationState x="160" y="200" animationId="{A_AMB}" id="{S_AMB}"/>
  </StateMachineLayer>
</StateMachine>
{ok.xml("Countersign", A_OK, OK_LEN)}
{bad.xml("Attack blocked", A_BAD, BAD_LEN)}
{amb.xml("Live", A_AMB, 96, loop="loop")}
</Artboard>
<ViewModel defaultInstanceId="{VM_INST}" name="Hero" id="{VM}">
  <ViewModelPropertyBoolean name="attacked" id="{P_ATTACKED}"/>
  <ViewModelInstance exports="true" name="Default" id="{VM_INST}">
    <ViewModelInstanceBoolean propertyValue="false" viewModelPropertyId="{P_ATTACKED}"/>
  </ViewModelInstance>
</ViewModel>
"""

write("hero", body)
