"""Generates rive/hero/scene.rml: the agent checkout card shown in the hero.

Two timelines, chosen by the view model's `attacked` flag:

- Countersign: the agent picks the item, Keelson sweeps the cart against the
  mandate, every field checks out, the payment goes through and the Split K
  seal closes.
- Attack blocked: a page slides in pushing a $340 bundle, the agent falls for
  it, the sweep catches the total above the mandate, nothing is paid and the
  order is blocked.

An ambient layer keeps the "live" dot breathing in both.

Draw order: in RML the first element declared paints on top, so `parts` is
written back-to-front and reversed when the scene is assembled.
"""

from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "hero" / "scene.rml"

# Brand palette (ARGB)
BONE = "FFF2F0EA"
WHITE = "FFFFFFFF"
GRAPHITE = "FF17181B"
TEXT2 = "FF5F5C56"
LINE = "FFD8D4C9"
VERMILION = "FFFF4B1F"
VERMILION_DEEP = "FFB82E06"
OK = "FF26704F"

W, H = 640, 470
CX = 300  # card centre x; the card spans 20..580 and the injected page pokes past it
LABEL_X, VALUE_X, TICK_X = 48, 196, 548
ROWS = {"mandate": 124, "cart": 176, "check": 228, "paid": 280, "status": 342}

_next = 100


def nid() -> str:
    global _next
    _next += 1
    return f"0:{_next}"


FONT = "0:10"
SANS = "0:11"


def style(name, size, color, weight=None, font=FONT):
    sid = nid()
    axis = f'<TextStyleAxis tag="2003265652" axisValue="{weight}" name="Weight"/>' if weight else ""
    family = "Geist Mono" if font == FONT else "Instrument Sans"
    return sid, (
        f'<TextStylePaint fontSize="{size}" fontAssetId="{font}" familyName="{family}" '
        f'styleName="Regular" name="{name}" id="{sid}">'
        f'<Fill name="Fill"><SolidColor colorValue="{color}" name="C"/></Fill>{axis}'
        f"</TextStylePaint>"
    )


def text(x, y, value, st, ox=0.0, opacity=1, tid=None):
    tid = tid or nid()
    sid, sxml = st
    return tid, (
        f'<Text x="{x}" y="{y}" originX="{ox}" originY="0.5" sizingValue="autoWidth" '
        f'opacity="{opacity}" name="T {value[:18]}" id="{tid}">{sxml}'
        f'<TextValueRun styleId="{sid}" text="{value}" name="Run"/></Text>'
    )


def paint(fill=None, stroke=None, thick=1.5, dash=None, gradient=None):
    out = ""
    if fill:
        out += f'<Fill name="Fill"><SolidColor colorValue="{fill}" name="C"/></Fill>'
    if stroke:
        dashes = (
            f'<DashPath name="Dashes"><Dash length="{dash[0]}" name="On"/><Dash length="{dash[1]}" name="Off"/></DashPath>'
            if dash
            else ""
        )
        out += f'<Stroke thickness="{thick}" cap="round" name="Stroke"><SolidColor colorValue="{stroke}" name="C"/>{dashes}</Stroke>'
    if gradient:
        stops = "".join(f'<GradientStop colorValue="{c}" position="{p}"/>' for c, p in gradient["stops"])
        out += (
            f'<Fill name="Fill"><LinearGradient startX="{gradient["sx"]}" startY="{gradient["sy"]}" '
            f'endX="{gradient["ex"]}" endY="{gradient["ey"]}" name="G">{stops}</LinearGradient></Fill>'
        )
    return out


def rect(x, y, w, h, r=0, ox=0.5, oy=0.5, sid=None, opacity=1, name=None, **p):
    sid = sid or nid()
    corners = f'cornerRadiusTL="{r}" cornerRadiusTR="{r}" cornerRadiusBL="{r}" cornerRadiusBR="{r}"' if r else ""
    return sid, (
        f'<Shape x="{x}" y="{y}" opacity="{opacity}" name="{name or "R" + sid}" id="{sid}">'
        f'<Rectangle width="{w}" height="{h}" originX="{ox}" originY="{oy}" {corners} name="Path"/>'
        f"{paint(**p)}</Shape>"
    )


def ellipse(x, y, d, sid=None, opacity=1, name=None, **p):
    sid = sid or nid()
    return sid, (
        f'<Shape x="{x}" y="{y}" opacity="{opacity}" name="{name or "E" + sid}" id="{sid}">'
        f'<Ellipse width="{d}" height="{d}" name="Path"/>{paint(**p)}</Shape>'
    )


def poly(points, x=0, y=0, sid=None, name=None, **p):
    sid = sid or nid()
    verts = "".join(f'<StraightVertex x="{px}" y="{py}"/>' for px, py in points)
    return sid, (
        f'<Shape x="{x}" y="{y}" name="{name or "P" + sid}" id="{sid}">'
        f'<PointsPath isClosed="true" isClockwise="true" name="Path">{verts}</PointsPath>{paint(**p)}</Shape>'
    )


def node(x, y, children, nid_=None, opacity=1, rotation=0, name=None, sx=1, sy=1):
    nid_ = nid_ or nid()
    # children are given back-to-front like `parts`
    inner = "".join(reversed(children))
    return nid_, (
        f'<Node x="{x}" y="{y}" opacity="{opacity}" rotation="{rotation}" scaleX="{sx}" scaleY="{sy}" '
        f'name="{name or "N" + nid_}" id="{nid_}">{inner}</Node>'
    )


parts = []
add = parts.append

# ---------------------------------------------------------------- the card
add(rect(CX, 215, 560, 390, r=14, fill=BONE, stroke=GRAPHITE, name="Card")[1])
flash, xml = rect(CX, 215, 560, 390, r=14, stroke=VERMILION, thick=3, opacity=0, name="Block flash")
add(xml)

live_dot, xml = ellipse(LABEL_X + 4, 48, 8, fill=VERMILION, name="Live dot")
add(xml)
live_ring, xml = ellipse(LABEL_X + 4, 48, 8, stroke=VERMILION, thick=1.5, opacity=0, name="Live ring")
add(xml)
add(text(LABEL_X + 18, 48, "AGENT CHECKOUT", style("Head", 12.5, GRAPHITE, 500))[1])
add(text(552, 48, "ORDER 7RX-2214", style("HeadR", 12.5, TEXT2), ox=1)[1])
add(rect(CX, 78, 560, 1.5, fill=GRAPHITE)[1])

for y in (150, 202, 254, 306):
    add(rect(CX, y, 504, 1, fill=LINE)[1])

# the sweep (behind the text, so it never reads as a strike-through): a vermilion line with a soft trail behind it
scan, xml = node(
    CX,
    104,
    [
        rect(
            0,
            -22,
            504,
            44,
            gradient={"sx": 0, "sy": -22, "ex": 0, "ey": 22, "stops": [("00FF4B1F", 0), ("29FF4B1F", 1)]},
            name="Trail",
        )[1],
        rect(0, 0, 504, 2, fill=VERMILION, name="Line")[1],
    ],
    opacity=0,
    name="Sweep",
)
add(xml)

for key, label in (("mandate", "MANDATE"), ("cart", "CART"), ("check", "CHECK"), ("paid", "PAID"), ("status", "STATUS")):
    add(text(LABEL_X, ROWS[key], label, style(f"Label {label}", 12.5, TEXT2))[1])

# a Text owns its styles, so every text gets a fresh one
def VAL():
    return style("Val", 15, GRAPHITE)


def VAL_STRONG():
    return style("Val strong", 15, GRAPHITE, 600)


def VAL_DIM():
    return style("Val dim", 15, TEXT2)

add(text(VALUE_X, ROWS["mandate"], "SHOES · SIZE 10 · MAX $100", VAL())[1])

cart_wait, xml = text(VALUE_X, ROWS["cart"], "—", VAL_DIM())
add(xml)
cart_ok, xml = text(VALUE_X, ROWS["cart"], "$94.00 · 1 PAIR · SIZE 10", VAL(), opacity=0)
add(xml)
cart_bad, xml = text(VALUE_X, ROWS["cart"], "$340.00 · BUNDLE DEAL", VAL_STRONG(), opacity=0)
add(xml)

check_wait, xml = text(VALUE_X, ROWS["check"], "WAITING FOR CART", VAL_DIM())
add(xml)
check_run, xml = text(VALUE_X, ROWS["check"], "CHECKING FIELD BY FIELD", VAL_DIM(), opacity=0)
add(xml)
check_ok, xml = text(VALUE_X, ROWS["check"], "INSIDE THE MANDATE", style("Val ok", 15, OK, 600), opacity=0)
add(xml)
check_bad, xml = text(VALUE_X, ROWS["check"], "TOTAL EXCEEDS MAX $100", style("Val bad", 15, VERMILION_DEEP, 600), opacity=0)
add(xml)

paid_wait, xml = text(VALUE_X, ROWS["paid"], "—", VAL_DIM())
add(xml)
paid_ok, xml = text(VALUE_X, ROWS["paid"], "$94.00 · VIA PAYPAL", VAL(), opacity=0)
add(xml)
paid_bad, xml = text(VALUE_X, ROWS["paid"], "$0.00 · NOTHING PAID", VAL_STRONG(), opacity=0)
add(xml)


# row ticks: a green square check for a field that passes, a vermilion cross for one that fails
def tick(row, good=True):
    if good:
        box = rect(0, 0, 18, 18, r=3, fill=OK)[1]
        mark = (
            f'<Shape name="Check"><PointsPath isClosed="false" name="Path">'
            f'<StraightVertex x="-4.5" y="0.5"/><StraightVertex x="-1.5" y="3.8"/><StraightVertex x="4.8" y="-3.6"/>'
            f'</PointsPath><Stroke thickness="2" cap="round" join="round" name="S"><SolidColor colorValue="{BONE}" name="C"/></Stroke></Shape>'
        )
        children = [box, mark]
    else:
        box = rect(0, 0, 18, 18, r=3, fill=VERMILION)[1]
        mark = (
            '<Shape name="Cross"><PointsPath isClosed="false" name="Path"><StraightVertex x="-4" y="-4"/><StraightVertex x="4" y="4"/></PointsPath>'
            '<PointsPath isClosed="false" name="Path 2"><StraightVertex x="4" y="-4"/><StraightVertex x="-4" y="4"/></PointsPath>'
            f'<Stroke thickness="2" cap="round" name="S"><SolidColor colorValue="{GRAPHITE}" name="C"/></Stroke></Shape>'
        )
        children = [box, mark]
    return node(TICK_X, ROWS[row], children, opacity=0, sx=0.4, sy=0.4, name=f"Tick {row} {'ok' if good else 'bad'}")


tick_mandate, xml = tick("mandate")
add(xml)
tick_cart_ok, xml = tick("cart")
add(xml)
tick_cart_bad, xml = tick("cart", good=False)
add(xml)

# injected-by-page frame around the cart row
inj, xml = node(
    CX,
    ROWS["cart"],
    [
        rect(0, 0, 520, 40, r=6, stroke=VERMILION_DEEP, thick=1.5, dash=(6, 4))[1],
        text(246, -27, "INJECTED BY THE PAGE", style("Inj", 10.5, VERMILION_DEEP, 600), ox=1)[1],
    ],
    opacity=0,
    name="Injected",
)
add(xml)


def chip(label, width, bg, fg, border=None, opacity=0):
    return node(
        VALUE_X + width / 2,
        ROWS["status"],
        [
            rect(0, 0, width, 32, r=4, fill=bg, stroke=border)[1],
            text(0, 0, label, style(f"Chip {label}", 13, fg, 600), ox=0.5)[1],
        ],
        opacity=opacity,
        name=f"Chip {label}",
    )


chip_wait, xml = chip("PENDING", 104, BONE, TEXT2, border=LINE, opacity=1)
add(xml)
chip_ok, xml = chip("COUNTERSIGNED", 164, GRAPHITE, BONE)
add(xml)
chip_bad, xml = chip("BLOCKED", 108, VERMILION, GRAPHITE)
add(xml)

# Split K seal: the stem is the mandate, the chevron is the countersignature
chev = nid()
seal, xml = node(
    500,
    ROWS["status"],
    [
        rect(0, 0, 13, 44, ox=0, fill=GRAPHITE, name="Stem")[1],
        poly(
            [(11, -22), (27, -22), (14, 0), (27, 22), (11, 22), (-2, 0)],
            x=52,
            sid=chev,
            name="Chevron",
            fill=VERMILION,
        )[1],
    ],
    opacity=0,
    name="Seal",
)
add(xml)
seal_ring, xml = ellipse(522, ROWS["status"], 70, stroke=VERMILION, thick=2, opacity=0, name="Seal ring")
add(xml)

# the page that tries to hijack the agent
page, xml = node(
    760,
    124,
[
        rect(0, 0, 232, 108, r=10, fill=WHITE, stroke=LINE)[1],
        text(-98, -32, "LIMITED TIME", style("Page kicker", 10, TEXT2, 500))[1],
        text(-98, -10, "Bundle deal", style("Page title", 17, GRAPHITE, 600, font=SANS))[1],
        text(98, -10, "$340", style("Page price", 17, VERMILION_DEEP, 600, font=SANS), ox=1)[1],
        rect(-52, 26, 92, 26, r=4, fill=GRAPHITE)[1],
        text(-52, 26, "ADD TO CART", style("Page cta", 10, BONE, 600), ox=0.5)[1],
    ],
    rotation=-0.035,
    name="Injected page",
)
add(xml)

# the agent's cursor, with a click ripple at its tip
ripple, ripple_xml = ellipse(0, 0, 30, stroke=VERMILION, thick=2, opacity=0, name="Ripple")
cursor, xml = node(
    90,
    520,
    [
        ripple_xml,
        poly(
            [(0, 0), (0, 23), (6, 17.5), (10.5, 27), (14.5, 25), (10, 16), (18, 16)],
            fill=GRAPHITE,
            stroke=BONE,
            thick=1.5,
            name="Arrow",
        )[1],
        rect(22, 34, 56, 20, r=4, ox=0, fill=GRAPHITE)[1],
        text(50, 34, "AGENT", style("Cursor tag", 10, BONE, 600), ox=0.5)[1],
    ],
    name="Agent cursor",
)
add(xml)

# ---------------------------------------------------------------- timelines
EASE_OUT = '<CubicEaseInterpolator x1="0.16" y1="1" x2="0.3" y2="1"/>'
EASE_IO = '<CubicEaseInterpolator x1="0.65" y1="0" x2="0.35" y2="1"/>'
BACK = '<CubicEaseInterpolator x1="0.34" y1="1.56" x2="0.64" y2="1"/>'

OP, X, Y, SX, SY = 18, 13, 14, 16, 17

DEFAULTS = {}  # (obj, prop) -> resting value at frame 0


def rest(obj, prop, value):
    DEFAULTS[(obj, prop)] = value


class Timeline:
    def __init__(self):
        self.tracks = {}

    def key(self, obj, prop, frames, ease=None):
        """frames: list of (frame, value); `ease` applies to every segment that ends on a later key."""
        self.tracks[(obj, prop)] = [(f, v, ease) for f, v in frames]
        return self

    def fade(self, obj, at, to, dur=10, ease=EASE_OUT):
        start = DEFAULTS.get((obj, OP), 1)
        return self.key(obj, OP, [(0, start), (at, start), (at + dur, to)], ease)

    def slide_in(self, obj, at, row_y, dist=12, dur=16):
        self.key(obj, OP, [(0, 0), (at, 0), (at + dur * 0.7, 1)], EASE_OUT)
        return self.key(obj, Y, [(0, row_y + dist), (at, row_y + dist), (at + dur, row_y)], EASE_OUT)

    def slide_out(self, obj, at, row_y, dist=12, dur=12):
        self.key(obj, OP, [(0, 1), (at, 1), (at + dur, 0)], EASE_OUT)
        return self.key(obj, Y, [(0, row_y), (at, row_y), (at + dur, row_y - dist)], EASE_OUT)

    def pop(self, obj, at, peak=1.0, start=0.4, dur=18, ease=BACK):
        self.key(obj, OP, [(0, 0), (at, 0), (at + 6, 1)])
        self.key(obj, SX, [(0, start), (at, start), (at + dur, peak)], ease)
        return self.key(obj, SY, [(0, start), (at, start), (at + dur, peak)], ease)

    def xml(self, name, aid, duration, loop="oneShot"):
        # every property any timeline touches is keyed here too, so switching states resets it
        for k, v in DEFAULTS.items():
            self.tracks.setdefault(k, [(0, v, None)])
        objs = {}
        for (obj, prop), frames in self.tracks.items():
            kfs = []
            for f, v, ease in frames:
                if ease:
                    kfs.append(f'<KeyFrameDouble value="{v}" frame="{int(f)}" interpolationType="cubic">{ease}</KeyFrameDouble>')
                else:
                    kfs.append(f'<KeyFrameDouble value="{v}" frame="{int(f)}" interpolationType="linear"/>')
            objs.setdefault(obj, []).append(f'<KeyedProperty propertyKey="{prop}">{"".join(kfs)}</KeyedProperty>')
        body = "".join(f'<KeyedObject objectId="{o}">{"".join(ps)}</KeyedObject>' for o, ps in objs.items())
        return f'<LinearAnimation loopValue="{loop}" duration="{duration}" name="{name}" id="{aid}">{body}</LinearAnimation>'


# resting values (frame 0 of both runs)
for obj, value in [
    (cart_wait, 1), (cart_ok, 0), (cart_bad, 0), (inj, 0),
    (check_wait, 1), (check_run, 0), (check_ok, 0), (check_bad, 0),
    (paid_wait, 1), (paid_ok, 0), (paid_bad, 0),
    (chip_wait, 1), (chip_ok, 0), (chip_bad, 0),
    (seal, 0), (seal_ring, 0), (scan, 0), (flash, 0), (ripple, 0),
    (tick_mandate, 0), (tick_cart_ok, 0), (tick_cart_bad, 0),
]:
    rest(obj, OP, value)
for obj in (tick_mandate, tick_cart_ok, tick_cart_bad):
    rest(obj, SX, 0.4)
    rest(obj, SY, 0.4)
for obj in (chip_ok, chip_bad, seal_ring):
    rest(obj, SX, 1)
    rest(obj, SY, 1)
rest(ripple, SX, 0.3)
rest(ripple, SY, 0.3)
rest(cart_ok, Y, ROWS["cart"])
rest(cart_bad, Y, ROWS["cart"])
rest(cart_wait, Y, ROWS["cart"])
rest(check_ok, Y, ROWS["check"])
rest(check_bad, Y, ROWS["check"])
rest(paid_ok, Y, ROWS["paid"])
rest(paid_bad, Y, ROWS["paid"])
rest(scan, Y, 104)
rest(chev, X, 52)
rest(cursor, X, 90)
rest(cursor, Y, 520)
rest(page, X, 760)


def sweep(tl, at, dur=64):
    tl.key(scan, OP, [(0, 0), (at, 0), (at + 6, 1), (at + dur, 1), (at + dur + 10, 0)])
    tl.key(scan, Y, [(0, 104), (at, 104), (at + dur, 300)], EASE_IO)
    tl.fade(check_wait, at, 0, 6).fade(check_run, at, 1, 8)
    tl.key(check_run, OP, [(0, 0), (at, 0), (at + 8, 1), (at + dur, 1), (at + dur + 6, 0)])
    # rows the line crosses, in frames after `at`
    return lambda y: at + dur * (y - 104) / (300 - 104)


def click(tl, at):
    tl.key(ripple, OP, [(0, 0), (at, 0), (at + 2, 1), (at + 22, 0)])
    tl.key(ripple, SX, [(0, 0.3), (at, 0.3), (at + 22, 1.7)], EASE_OUT)
    tl.key(ripple, SY, [(0, 0.3), (at, 0.3), (at + 22, 1.7)], EASE_OUT)


# Countersign
ok = Timeline()
ok.key(cursor, X, [(0, 90), (34, 330), (52, 330), (84, 700)], EASE_IO)
ok.key(cursor, Y, [(0, 520), (34, 186), (52, 186), (84, 150)], EASE_IO)
click(ok, 36)
ok.slide_out(cart_wait, 38, ROWS["cart"]).slide_in(cart_ok, 40, ROWS["cart"])
cross = sweep(ok, 64)
ok.pop(tick_mandate, cross(ROWS["mandate"]))
ok.pop(tick_cart_ok, cross(ROWS["cart"]))
done = 64 + 64
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

# Attack blocked
bad = Timeline()
bad.key(page, X, [(0, 760), (8, 760), (34, 500), (100, 500), (122, 760)], EASE_OUT)
bad.key(cursor, X, [(0, 90), (30, 300), (52, 448), (70, 448), (96, 330), (112, 330), (140, 700)], EASE_IO)
bad.key(cursor, Y, [(0, 520), (30, 300), (52, 150), (70, 150), (96, 186), (112, 186), (140, 150)], EASE_IO)
click(bad, 56)
bad.slide_out(cart_wait, 98, ROWS["cart"]).slide_in(cart_bad, 100, ROWS["cart"])
bad.key(inj, OP, [(0, 0), (112, 0), (124, 1)], EASE_OUT)
cross = sweep(bad, 128)
bad.pop(tick_mandate, cross(ROWS["mandate"]))
bad.pop(tick_cart_bad, cross(ROWS["cart"]))
done = 128 + 64
bad.slide_in(check_bad, done + 2, ROWS["check"])
bad.slide_out(paid_wait, done + 10, ROWS["paid"]).slide_in(paid_bad, done + 12, ROWS["paid"])
bad.fade(chip_wait, done + 18, 0, 4)
bad.pop(chip_bad, done + 20, start=1.35, dur=14, ease=EASE_OUT)
bad.key(flash, OP, [(0, 0), (done + 20, 0), (done + 23, 1), (done + 60, 0)], EASE_OUT)
BAD_LEN = done + 80

# Ambient: the live dot breathes
amb_body = (
    f'<KeyedObject objectId="{live_ring}">'
    f'<KeyedProperty propertyKey="{OP}"><KeyFrameDouble value="0.8" frame="0" interpolationType="linear"/><KeyFrameDouble value="0" frame="72" interpolationType="linear"/></KeyedProperty>'
    f'<KeyedProperty propertyKey="{SX}"><KeyFrameDouble value="1" frame="0" interpolationType="cubic">{EASE_OUT}</KeyFrameDouble><KeyFrameDouble value="2.6" frame="72" interpolationType="linear"/></KeyedProperty>'
    f'<KeyedProperty propertyKey="{SY}"><KeyFrameDouble value="1" frame="0" interpolationType="cubic">{EASE_OUT}</KeyFrameDouble><KeyFrameDouble value="2.6" frame="72" interpolationType="linear"/></KeyedProperty>'
    f"</KeyedObject>"
)

# ---------------------------------------------------------------- view model + machine
VM, VM_INST, P_ATTACKED = "0:60", "0:61", "0:62"
SM, LAYER, AMB_LAYER = "0:70", "0:71", "0:74"
S_OK, S_BAD, S_AMB = "0:72", "0:73", "0:75"
A_OK, A_BAD, A_AMB = "0:80", "0:81", "0:82"


def when_attacked(value):
    return (
        '<TransitionViewModelCondition opValue="equal">'
        "<TransitionPropertyViewModelComparator><BindablePropertyBoolean>"
        f'<DataBindContext sourcePathIds="{VM}-{P_ATTACKED}" propertyKey="634"/>'
        "</BindablePropertyBoolean></TransitionPropertyViewModelComparator>"
        f'<TransitionValueBooleanComparator value="{"true" if value else "false"}"/>'
        "</TransitionViewModelCondition>"
    )


machine = f"""
<StateMachine name="Checkout" id="{SM}">
  <StateMachineLayer name="Flow" id="{LAYER}">
    <EntryState x="0" y="0"><StateTransition stateToId="{S_OK}"/></EntryState>
    <AnyState x="160" y="-140"/>
    <ExitState x="480" y="-140"/>
    <AnimationState x="160" y="0" animationId="{A_OK}" reset="true" id="{S_OK}">
      <StateTransition stateToId="{S_BAD}">{when_attacked(True)}</StateTransition>
    </AnimationState>
    <AnimationState x="400" y="0" animationId="{A_BAD}" reset="true" id="{S_BAD}">
      <StateTransition stateToId="{S_OK}">{when_attacked(False)}</StateTransition>
    </AnimationState>
  </StateMachineLayer>
  <StateMachineLayer name="Ambient" id="{AMB_LAYER}">
    <EntryState x="0" y="200"><StateTransition stateToId="{S_AMB}"/></EntryState>
    <AnyState x="160" y="60"/>
    <ExitState x="480" y="60"/>
    <AnimationState x="160" y="200" animationId="{A_AMB}" id="{S_AMB}"/>
  </StateMachineLayer>
</StateMachine>
"""

scene = f"""<Rive version="1" kind="fragment">
<Artboard defaultStateMachineId="{SM}" viewModelId="{VM}" viewModelInstanceId="{VM_INST}" styleId="0:3" width="{W}" height="{H}" name="Hero" id="0:2">
<LayoutComponentStyle name="Hero Style" id="0:3"/>
{''.join(reversed(parts))}
{machine}
{ok.xml("Countersign", A_OK, OK_LEN)}
{bad.xml("Attack blocked", A_BAD, BAD_LEN)}
<LinearAnimation loopValue="loop" duration="96" name="Live" id="{A_AMB}">{amb_body}</LinearAnimation>
</Artboard>
<ViewModel defaultInstanceId="{VM_INST}" name="Hero" id="{VM}">
  <ViewModelPropertyBoolean name="attacked" id="{P_ATTACKED}"/>
  <ViewModelInstance exports="true" name="Default" id="{VM_INST}">
    <ViewModelInstanceBoolean propertyValue="false" viewModelPropertyId="{P_ATTACKED}"/>
  </ViewModelInstance>
</ViewModel>
<FontAsset file="../fonts/GeistMono.ttf" name="Geist Mono" id="{FONT}"/>
<FontAsset file="../fonts/InstrumentSans.ttf" name="Instrument Sans" id="{SANS}"/>
</Rive>
"""

OUT.write_text(scene)
print(f"wrote {OUT}  countersign={OK_LEN}f  attack={BAD_LEN}f")
