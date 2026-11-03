"""Hero artboards: an agent checkout card, wide (Hero) and tall (HeroMobile).

Two runs, chosen by the view model's `attacked` flag:

- Countersign: the agent picks the item, Keelson sweeps the cart against the
  mandate, every field checks out, the payment goes through and the Split K
  seal closes.
- Attack blocked: a page slides in pushing a $340 bundle, the agent falls for
  it, the sweep catches the total above the mandate, nothing is paid and the
  order is blocked.

An ambient layer keeps the "live" dot breathing in both. The tall variant
stacks each label over its value so the text stays readable on a phone.
"""

from dataclasses import dataclass

from rml import (
    BONE, EASE_IO, EASE_OUT, GRAPHITE, LINE, OK, OP, SANS, SX, SY, TEXT2, VERMILION,
    VERMILION_DEEP, WHITE, X, Y, Builder, Timeline, bool_condition, write,
)

ROW_KEYS = ("mandate", "cart", "check", "paid", "status")


@dataclass
class Layout:
    name: str
    id_start: int
    stage_x: int
    w: int
    h: int
    card: tuple  # cx, cy, w, h
    label_x: int
    value_x: int
    tick_x: int
    label_y: dict
    value_y: dict
    separators: tuple
    scan: tuple  # top, bottom
    seal: tuple  # x, y
    page: tuple  # start x, end x, y, width
    inj_w: int
    inj_tag_below: bool
    # cursor paths: (frame, x, y)
    ok_path: tuple
    bad_path: tuple


WIDE = Layout(
    name="Hero", id_start=1000, stage_x=0, w=640, h=470,
    card=(300, 215, 560, 390), label_x=48, value_x=196, tick_x=548,
    label_y={"mandate": 124, "cart": 176, "check": 228, "paid": 280, "status": 342},
    value_y={"mandate": 124, "cart": 176, "check": 228, "paid": 280, "status": 342},
    separators=(150, 202, 254, 306), scan=(104, 300), seal=(500, 342),
    page=(760, 500, 124, 232), inj_w=520, inj_tag_below=False,
    ok_path=((0, 90, 520), (34, 330, 186), (52, 330, 186), (84, 700, 150)),
    bad_path=((0, 90, 520), (30, 300, 300), (52, 448, 150), (70, 448, 150), (96, 330, 186), (112, 330, 186), (140, 700, 150)),
)

TALL = Layout(
    name="HeroMobile", id_start=1600, stage_x=700, w=360, h=480,
    card=(180, 235, 328, 430), label_x=36, value_x=36, tick_x=312,
    label_y={"mandate": 104, "cart": 168, "check": 232, "paid": 296, "status": 360},
    value_y={"mandate": 128, "cart": 192, "check": 256, "paid": 320, "status": 394},
    separators=(150, 214, 278, 342), scan=(96, 336), seal=(250, 394),
    page=(470, 228, 150, 212), inj_w=304, inj_tag_below=True,
    ok_path=((0, 60, 540), (34, 170, 200), (52, 170, 200), (84, 420, 140)),
    bad_path=((0, 60, 540), (30, 150, 360), (52, 200, 176), (70, 200, 176), (96, 170, 200), (112, 170, 200), (140, 420, 140)),
)


def build(L: Layout) -> str:
    b = Builder(L.id_start)
    parts = []
    add = parts.append
    cx, cy, cw, ch = L.card
    top = cy - ch / 2
    inner = cw - 56
    right = cx + cw / 2 - 28

    # ------------------------------------------------------------ the card
    add(b.rect(cx, cy, cw, ch, r=14, fill=BONE, stroke=GRAPHITE, name="Card")[1])
    flash, xml = b.rect(cx, cy, cw, ch, r=14, stroke=VERMILION, thick=3, opacity=0, name="Block flash")
    add(xml)

    head_y = top + 28
    live_ring, xml = b.ellipse(L.label_x + 4, head_y, 8, stroke=VERMILION, thick=1.5, opacity=0, name="Live ring")
    add(xml)
    add(b.ellipse(L.label_x + 4, head_y, 8, fill=VERMILION, name="Live dot")[1])
    add(b.text(L.label_x + 18, head_y, "AGENT CHECKOUT", 12.5, GRAPHITE, 500)[1])
    add(b.text(right, head_y, "ORDER 7RX-2214", 12.5, TEXT2, ox=1)[1])
    add(b.rect(cx, top + 58, cw, 1.5, fill=GRAPHITE)[1])

    for y in L.separators:
        add(b.rect(cx, y, inner, 1, fill=LINE)[1])

    # the sweep sits behind the text, so it never reads as a strike-through
    scan_top, scan_bottom = L.scan
    scan, xml = b.node(
        cx,
        scan_top,
        [
            b.rect(0, -22, inner, 44, gradient={"sx": 0, "sy": -22, "ex": 0, "ey": 22,
                                                "stops": [("00FF4B1F", 0), ("29FF4B1F", 1)]}, name="Trail")[1],
            b.rect(0, 0, inner, 2, fill=VERMILION, name="Line")[1],
        ],
        opacity=0,
        name="Sweep",
    )
    add(xml)

    for key, label in zip(ROW_KEYS, ("MANDATE", "CART", "CHECK", "PAID", "STATUS")):
        add(b.text(L.label_x, L.label_y[key], label, 12.5, TEXT2)[1])

    add(b.text(L.value_x, L.value_y["mandate"], "SHOES · SIZE 10 · MAX $100", 15, GRAPHITE)[1])

    def value(row, label, color=GRAPHITE, weight=None, opacity=0):
        tid, xml = b.text(L.value_x, L.value_y[row], label, 15, color, weight, opacity=opacity)
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
        tid, xml = b.node(L.tick_x, L.value_y[row], [box, mark], opacity=0, sx=0.4, sy=0.4, name=f"Tick {row}")
        add(xml)
        return tid

    tick_mandate = tick("mandate")
    tick_cart_ok = tick("cart")
    tick_cart_bad = tick("cart", good=False)

    inj_mid = (L.label_y["cart"] + L.value_y["cart"]) / 2
    inj_h = (L.value_y["cart"] - L.label_y["cart"]) + 40
    inj, xml = b.node(
        cx,
        inj_mid,
        [
            b.rect(0, 0, L.inj_w, inj_h, r=6, stroke=VERMILION_DEEP, thick=1.5, dash=(6, 4))[1],
            b.text(L.inj_w / 2 - 6, (inj_h / 2 + 10) if L.inj_tag_below else (-inj_h / 2 - 7),
                   "INJECTED BY THE PAGE", 10.5, VERMILION_DEEP, 600, ox=1)[1],
        ],
        opacity=0,
        name="Injected",
    )
    add(xml)

    def chip(label, width, bg, fg, border=None, opacity=0):
        cid, xml = b.node(
            L.value_x + width / 2,
            L.value_y["status"],
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
    seal_x, seal_y = L.seal
    seal, xml = b.node(
        seal_x,
        seal_y,
        [
            b.rect(0, 0, 13, 44, ox=0, fill=GRAPHITE, name="Stem")[1],
            b.poly([(11, -22), (27, -22), (14, 0), (27, 22), (11, 22), (-2, 0)], x=52, sid=chev, name="Chevron", fill=VERMILION)[1],
        ],
        opacity=0,
        name="Seal",
    )
    add(xml)
    seal_ring, xml = b.ellipse(seal_x + 22, seal_y, 70, stroke=VERMILION, thick=2, opacity=0, name="Seal ring")
    add(xml)

    # the page that tries to hijack the agent
    page_from, page_to, page_y, page_w = L.page
    half = page_w / 2
    page, xml = b.node(
        page_from,
        page_y,
        [
            b.rect(0, 0, page_w, 108, r=10, fill=WHITE, stroke=LINE)[1],
            b.text(-half + 18, -32, "LIMITED TIME", 10, TEXT2, 500)[1],
            b.text(-half + 18, -10, "Bundle deal", 17, GRAPHITE, 600, font=SANS)[1],
            b.text(half - 18, -10, "$340", 17, VERMILION_DEEP, 600, font=SANS, ox=1)[1],
            b.rect(-half + 18 + 46, 26, 92, 26, r=4, fill=GRAPHITE)[1],
            b.text(-half + 18 + 46, 26, "ADD TO CART", 10, BONE, 600, ox=0.5)[1],
        ],
        rotation=-0.035,
        name="Injected page",
    )
    add(xml)

    ripple, ripple_xml = b.ellipse(0, 0, 30, stroke=VERMILION, thick=2, opacity=0, name="Ripple")
    start_x, start_y = L.ok_path[0][1], L.ok_path[0][2]
    cursor, xml = b.node(
        start_x,
        start_y,
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

    # ------------------------------------------------------------ timelines
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
        D[(obj, Y)] = L.value_y[row]
    D[(scan, Y)] = scan_top
    D[(chev, X)] = 52
    D[(cursor, X)] = start_x
    D[(cursor, Y)] = start_y
    D[(page, X)] = page_from

    def sweep(tl, at, dur=64):
        tl.key(scan, OP, [(0, 0), (at, 0), (at + 6, 1), (at + dur, 1), (at + dur + 10, 0)])
        tl.key(scan, Y, [(0, scan_top), (at, scan_top), (at + dur, scan_bottom)], EASE_IO)
        tl.fade(check_wait, at, 0, 6)
        tl.key(check_run, OP, [(0, 0), (at, 0), (at + 8, 1), (at + dur, 1), (at + dur + 6, 0)])
        return lambda y: at + dur * (y - scan_top) / (scan_bottom - scan_top)

    def click(tl, at):
        tl.key(ripple, OP, [(0, 0), (at, 0), (at + 2, 1), (at + 22, 0)])
        tl.key(ripple, SX, [(0, 0.3), (at, 0.3), (at + 22, 1.7)], EASE_OUT)
        tl.key(ripple, SY, [(0, 0.3), (at, 0.3), (at + 22, 1.7)], EASE_OUT)

    def walk(tl, path):
        tl.key(cursor, X, [(f, x) for f, x, _ in path], EASE_IO)
        tl.key(cursor, Y, [(f, y) for f, _, y in path], EASE_IO)

    vy = L.value_y
    ok = Timeline(D)
    walk(ok, L.ok_path)
    click(ok, 36)
    ok.slide_out(cart_wait, 38, vy["cart"]).slide_in(cart_ok, 40, vy["cart"])
    cross = sweep(ok, 64)
    ok.pop(tick_mandate, cross(vy["mandate"]))
    ok.pop(tick_cart_ok, cross(vy["cart"]))
    done = 128
    ok.slide_in(check_ok, done + 2, vy["check"])
    ok.slide_out(paid_wait, done + 10, vy["paid"]).slide_in(paid_ok, done + 12, vy["paid"])
    ok.fade(chip_wait, done + 18, 0, 6)
    ok.pop(chip_ok, done + 20, start=0.86, dur=16)
    ok.key(seal, OP, [(0, 0), (done + 26, 0), (done + 30, 1)])
    ok.key(chev, X, [(0, 52), (done + 26, 52), (done + 50, 16)], EASE_OUT)
    ok.key(seal_ring, OP, [(0, 0), (done + 48, 0), (done + 50, 0.9), (done + 76, 0)])
    ok.key(seal_ring, SX, [(0, 0.6), (done + 48, 0.6), (done + 76, 1.5)], EASE_OUT)
    ok.key(seal_ring, SY, [(0, 0.6), (done + 48, 0.6), (done + 76, 1.5)], EASE_OUT)
    ok_len = done + 90

    bad = Timeline(D)
    bad.key(page, X, [(0, page_from), (8, page_from), (34, page_to), (100, page_to), (122, page_from)], EASE_OUT)
    walk(bad, L.bad_path)
    click(bad, 56)
    bad.slide_out(cart_wait, 98, vy["cart"]).slide_in(cart_bad, 100, vy["cart"])
    bad.key(inj, OP, [(0, 0), (112, 0), (124, 1)], EASE_OUT)
    cross = sweep(bad, 128)
    bad.pop(tick_mandate, cross(vy["mandate"]))
    bad.pop(tick_cart_bad, cross(vy["cart"]))
    done = 192
    bad.slide_in(check_bad, done + 2, vy["check"])
    bad.slide_out(paid_wait, done + 10, vy["paid"]).slide_in(paid_bad, done + 12, vy["paid"])
    bad.fade(chip_wait, done + 18, 0, 4)
    bad.pop(chip_bad, done + 20, start=1.35, dur=14, ease=EASE_OUT)
    bad.key(flash, OP, [(0, 0), (done + 20, 0), (done + 23, 1), (done + 60, 0)], EASE_OUT)
    bad_len = done + 80

    amb = Timeline({})
    amb.key(live_ring, OP, [(0, 0.8), (72, 0)])
    amb.key(live_ring, SX, [(0, 1), (72, 2.6)], EASE_OUT)
    amb.key(live_ring, SY, [(0, 1), (72, 2.6)], EASE_OUT)

    # ------------------------------------------------------------ view model + machine
    vm, vm_inst, p_attacked = b.nid(), b.nid(), b.nid()
    sm, layer, amb_layer, s_ok, s_bad, s_amb = (b.nid() for _ in range(6))
    a_ok, a_bad, a_amb, art, art_style = (b.nid() for _ in range(5))

    return f"""
<Artboard defaultStateMachineId="{sm}" viewModelId="{vm}" viewModelInstanceId="{vm_inst}" styleId="{art_style}" width="{L.w}" height="{L.h}" x="{L.stage_x}" y="0" name="{L.name}" id="{art}">
<LayoutComponentStyle name="{L.name} Style" id="{art_style}"/>
{''.join(reversed(parts))}
<StateMachine name="Checkout" id="{sm}">
  <StateMachineLayer name="Flow" id="{layer}">
    <EntryState x="0" y="0"><StateTransition stateToId="{s_ok}"/></EntryState>
    <AnyState x="160" y="-140"/>
    <ExitState x="480" y="-140"/>
    <AnimationState x="160" y="0" animationId="{a_ok}" reset="true" id="{s_ok}">
      <StateTransition stateToId="{s_bad}">{bool_condition(vm, p_attacked, True)}</StateTransition>
    </AnimationState>
    <AnimationState x="400" y="0" animationId="{a_bad}" reset="true" id="{s_bad}">
      <StateTransition stateToId="{s_ok}">{bool_condition(vm, p_attacked, False)}</StateTransition>
    </AnimationState>
  </StateMachineLayer>
  <StateMachineLayer name="Ambient" id="{amb_layer}">
    <EntryState x="0" y="200"><StateTransition stateToId="{s_amb}"/></EntryState>
    <AnyState x="160" y="60"/>
    <ExitState x="480" y="60"/>
    <AnimationState x="160" y="200" animationId="{a_amb}" id="{s_amb}"/>
  </StateMachineLayer>
</StateMachine>
{ok.xml("Countersign", a_ok, ok_len)}
{bad.xml("Attack blocked", a_bad, bad_len)}
{amb.xml("Live", a_amb, 96, loop="loop")}
</Artboard>
<ViewModel defaultInstanceId="{vm_inst}" name="{L.name}" id="{vm}">
  <ViewModelPropertyBoolean name="attacked" id="{p_attacked}"/>
  <ViewModelInstance exports="true" name="Default" id="{vm_inst}">
    <ViewModelInstanceBoolean propertyValue="false" viewModelPropertyId="{p_attacked}"/>
  </ViewModelInstance>
</ViewModel>
"""


write("hero", build(WIDE) + build(TALL))
