"""Generate the Black Gravity animated logo (pure SVG, no JavaScript).

Text is converted to outlines for consistent rendering in browsers and on GitHub.
Install dependencies: python -m pip install fonttools==4.68.0 uharfbuzz==0.57.0
Usage: python3 build_logo.py <fonts-directory> <output-directory>
"""
import io, math, random, sys, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import uharfbuzz as hb

FONTS, OUT = sys.argv[1], sys.argv[2]
NAME = os.environ.get("LOGO_NAME", "BLACK GRAVITY")
SUB = os.environ.get("LOGO_SUB", "MULTI-AGENT ORCHESTRATION ENGINE")
TAG = os.environ.get("LOGO_TAG", "Many minds. One gravity.")


class Font:
    def __init__(self, path):
        tt = TTFont(path)
        tt.flavor = None
        buf = io.BytesIO(); tt.save(buf)
        self.tt = TTFont(io.BytesIO(buf.getvalue()))
        self.gs = self.tt.getGlyphSet()
        self.upm = self.tt["head"].unitsPerEm
        face = hb.Face(buf.getvalue())
        self.hbfont = hb.Font(face)
        self.order = self.tt.getGlyphOrder()

    def path(self, text, size, x, y, tracking=0.0, anchor="middle"):
        buf = hb.Buffer(); buf.add_str(text); buf.guess_segment_properties()
        hb.shape(self.hbfont, buf, {"kern": True, "liga": True})
        s = size / self.upm
        trk = tracking * size
        glyphs, pen_x = [], 0.0
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            glyphs.append((self.order[info.codepoint], pen_x + pos.x_offset * s, pos.y_offset * s))
            pen_x += pos.x_advance * s + trk
        width = pen_x - trk
        x0 = x - width / 2 if anchor == "middle" else x
        pen = SVGPathPen(self.gs, ntos=lambda v: f"{v:.1f}".rstrip("0").rstrip("."))
        for name, gx, gy in glyphs:
            tp = TransformPen(pen, (s, 0, 0, -s, x0 + gx, y - gy))
            self.gs[name].draw(tp)
        return pen.getCommands(), width


def f(path):
    return Font(os.path.join(FONTS, path))


SORA = f("fontsource-sora-5.3.0/package/files/sora-latin-700-normal.woff")
SORA_M = f("fontsource-sora-5.3.0/package/files/sora-latin-500-normal.woff")
SERIF_I = f("fontsource-instrument-serif-5.3.0/package/files/instrument-serif-latin-400-italic.woff")


def stars(rng, n, w, h, avoid):
    out = []
    ax, ay, ar = avoid
    while len(out) < n:
        x, y = rng.uniform(30, w - 30), rng.uniform(30, h - 30)
        if math.hypot(x - ax, (y - ay) * 1.4) < ar:
            continue
        r = rng.choice([0.6, 0.8, 0.8, 1.0, 1.3, 1.7])
        dur = rng.uniform(2.5, 6.5)
        lo = rng.uniform(0.08, 0.3)
        hi = rng.uniform(0.55, 0.95)
        out.append(
            f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="#e9e3ff" opacity="{lo:.2f}">'
            f'<animate attributeName="opacity" values="{lo:.2f};{hi:.2f};{lo:.2f}" dur="{dur:.1f}s" '
            f'begin="-{rng.uniform(0, dur):.1f}s" repeatCount="indefinite"/></circle>'
        )
    return "\n    ".join(out)


def orbit(i, cx, cy, rx, ry, rot, planets, stroke_op):
    """Tilted orbit with planets (agents) traveling around the ellipse.
    The lower half is in front (larger and brighter). The upper half is behind."""
    pid = f"orb{i}"
    d = f"M {rx},0 A {rx},{ry} 0 1 1 {-rx},0 A {rx},{ry} 0 1 1 {rx},0"
    parts = [
        f'<g transform="translate({cx} {cy}) rotate({rot})">',
        f'  <path id="{pid}" d="{d}" fill="none" stroke="url(#orbitStroke)" stroke-width="1.4" opacity="{stroke_op}"/>',
    ]
    for (r, color, dur, phase, glow) in planets:
        begin = -dur * phase
        # trail: delayed copies, smaller and more transparent
        for k, (lag, scale, op) in enumerate([(0.045, 0.55, 0.18), (0.03, 0.7, 0.28), (0.015, 0.85, 0.45)]):
            parts.append(
                f'  <circle r="{r*scale:.2f}" fill="{color}" opacity="{op}">'
                f'<animateMotion dur="{dur}s" begin="{begin + lag*dur:.2f}s" repeatCount="indefinite"><mpath href="#{pid}" xlink:href="#{pid}"/></animateMotion></circle>'
            )
        parts.append(
            f'  <g><animateMotion dur="{dur}s" begin="{begin:.2f}s" repeatCount="indefinite"><mpath href="#{pid}" xlink:href="#{pid}"/></animateMotion>'
            f'<circle r="{r*3.2:.1f}" fill="url(#{glow})"/>'
            f'<circle r="{r}" fill="{color}">'
            f'<animate attributeName="r" values="{r};{r*1.22:.2f};{r};{r*0.78:.2f};{r}" keyTimes="0;0.25;0.5;0.75;1" dur="{dur}s" begin="{begin:.2f}s" repeatCount="indefinite"/>'
            f'<animate attributeName="opacity" values="0.95;1;0.9;0.55;0.95" keyTimes="0;0.25;0.5;0.75;1" dur="{dur}s" begin="{begin:.2f}s" repeatCount="indefinite"/>'
            f'</circle></g>'
        )
    parts.append("</g>")
    return "\n    ".join(parts)


def black_hole(cx, cy, k=1.0):
    """Shadow, photon ring, and gravitationally lensed accretion disk."""
    R = 46 * k            # event horizon
    # (rx, ry) of the outer and inner disk edges
    ORX, ORY, IRX, IRY = 190 * k, 40 * k, 66 * k, 13 * k
    back = lambda rx, ry: f"M {cx-rx:.1f},{cy} A {rx:.1f},{ry:.1f} 0 0 1 {cx+rx:.1f},{cy}"
    front = lambda rx, ry: f"M {cx+rx:.1f},{cy} A {rx:.1f},{ry:.1f} 0 0 1 {cx-rx:.1f},{cy}"

    def annulus(side):
        if side == "back":
            return (f"M {cx-ORX:.1f},{cy} A {ORX:.1f},{ORY:.1f} 0 0 1 {cx+ORX:.1f},{cy} "
                    f"L {cx+IRX:.1f},{cy} A {IRX:.1f},{IRY:.1f} 0 0 0 {cx-IRX:.1f},{cy} Z")
        return (f"M {cx+ORX:.1f},{cy} A {ORX:.1f},{ORY:.1f} 0 0 1 {cx-ORX:.1f},{cy} "
                f"L {cx-IRX:.1f},{cy} A {IRX:.1f},{IRY:.1f} 0 0 0 {cx+IRX:.1f},{cy} Z")

    # disk bands: (radius fraction, width, color, opacity, dash, period in seconds)
    # shorter periods near the center: "Keplerian" rotation
    BANDS = [
        (0.97, 1.4, "#8f74ff", 0.55, (60, 26, 10, 30), 4.2),
        (0.84, 2.6, "url(#diskGrad)", 0.75, (52, 14, 6, 22), 3.0),
        (0.70, 2.0, "#e4dcff", 0.8, (38, 10, 14, 12), 2.1),
        (0.56, 3.0, "url(#diskGrad)", 0.95, (30, 8, 4, 10), 1.4),
        (0.44, 1.6, "#ffffff", 1.0, (18, 6, 3, 7), 0.9),
    ]

    def disk(pathfn, side):
        op = 1 if side == "front" else 0.7
        out = [
            f'<path d="{pathfn(ORX*0.8, ORY*0.8)}" fill="none" stroke="#7c5cff" stroke-width="{34*k:.1f}" opacity="{0.3*op:.2f}" filter="url(#blurL)"/>',
            f'<path d="{annulus(side)}" fill="url(#diskFill)" opacity="{0.55*op:.2f}" filter="url(#blurS)"/>',
        ]
        for frac, w, color, o, dash, per in BANDS:
            rx, ry = IRX + (ORX - IRX) * frac, IRY + (ORY - IRY) * frac
            rx, ry = rx * 1.0, ry * 1.0
            da = " ".join(f"{d*k:.0f}" for d in dash)
            total = sum(dash) * k
            out.append(
                f'<path d="{pathfn(rx, ry)}" fill="none" stroke="{color}" stroke-width="{w*k:.1f}" opacity="{o*op:.2f}" '
                f'stroke-dasharray="{da}" stroke-linecap="round">'
                f'<animate attributeName="stroke-dashoffset" from="0" to="-{total:.0f}" dur="{per}s" repeatCount="indefinite"/></path>'
            )
        # hot inner edge
        out.append(f'<path d="{pathfn(IRX*1.06, IRY*1.06)}" fill="none" stroke="#ffffff" stroke-width="{2.2*k:.1f}" opacity="{0.9*op:.2f}" filter="url(#blurXS)"/>')
        return "\n      " + "\n      ".join(out)

    return f"""
    <!-- brilho gravitacional -->
    <circle cx="{cx}" cy="{cy}" r="{190*k:.0f}" fill="url(#halo)">
      <animate attributeName="opacity" values="0.75;1;0.75" dur="6s" repeatCount="indefinite"/>
    </circle>
    <!-- ondas gravitacionais -->
    <circle cx="{cx}" cy="{cy}" r="{R}" fill="none" stroke="#a78bfa" stroke-width="1.5" opacity="0">
      <animate attributeName="r" values="{R+6};{230*k:.0f}" dur="6s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.45;0" dur="6s" repeatCount="indefinite"/>
    </circle>
    <circle cx="{cx}" cy="{cy}" r="{R}" fill="none" stroke="#a78bfa" stroke-width="1.5" opacity="0">
      <animate attributeName="r" values="{R+6};{230*k:.0f}" dur="6s" begin="-3s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.45;0" dur="6s" begin="-3s" repeatCount="indefinite"/>
    </circle>
    <g transform="rotate(-9 {cx} {cy})">
      <!-- parte de trás do disco -->{disk(back, "back")}
      <!-- disco traseiro curvado pela lente (anel acima e abaixo da sombra) -->
      <ellipse cx="{cx}" cy="{cy-2*k:.1f}" rx="{R*1.42:.1f}" ry="{R*1.36:.1f}" fill="none" stroke="url(#lensGrad)" stroke-width="{16*k:.1f}" filter="url(#blurM)" opacity="0.85"/>
      <ellipse cx="{cx}" cy="{cy-2*k:.1f}" rx="{R*1.32:.1f}" ry="{R*1.26:.1f}" fill="none" stroke="url(#lensGrad)" stroke-width="{5*k:.1f}" filter="url(#blurXS)"/>
      <ellipse cx="{cx}" cy="{cy-1*k:.1f}" rx="{R*1.2:.1f}" ry="{R*1.16:.1f}" fill="none" stroke="url(#lensGrad)" stroke-width="{1.6*k:.1f}" opacity="0.9" stroke-dasharray="{30*k:.0f} {6*k:.0f} {10*k:.0f} {8*k:.0f}">
        <animate attributeName="stroke-dashoffset" from="0" to="-{54*k:.0f}" dur="1.2s" repeatCount="indefinite"/></ellipse>
      <!-- horizonte de eventos -->
      <circle cx="{cx}" cy="{cy}" r="{R}" fill="url(#shadow)"/>
      <!-- anel de fótons -->
      <circle cx="{cx}" cy="{cy}" r="{R+1.2*k:.1f}" fill="none" stroke="#f3efff" stroke-width="{1.3*k:.1f}" opacity="0.95">
        <animate attributeName="opacity" values="0.7;1;0.7" dur="3s" repeatCount="indefinite"/>
      </circle>
      <!-- frente do disco (passa na frente da sombra) -->{disk(front, "front")}
    </g>"""


DEFS = """
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#100d1f"/><stop offset="1" stop-color="#08070f"/>
    </linearGradient>
    <radialGradient id="nebula" cx="0.5" cy="0.38" r="0.6">
      <stop offset="0" stop-color="#5b3fd1" stop-opacity="0.28"/>
      <stop offset="0.5" stop-color="#3a2690" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="halo">
      <stop offset="0.18" stop-color="#b39dff" stop-opacity="0.55"/>
      <stop offset="0.4" stop-color="#7c5cff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#7c5cff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="shadow">
      <stop offset="0.8" stop-color="#000"/><stop offset="1" stop-color="#0d0920"/>
    </radialGradient>
    <linearGradient id="diskGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.3" stop-color="#d8ccff"/>
      <stop offset="0.65" stop-color="#9f86ff"/>
      <stop offset="1" stop-color="#6a4de6"/>
    </linearGradient>
    <linearGradient id="lensGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f6f2ff"/>
      <stop offset="0.35" stop-color="#a78bfa" stop-opacity="0.55"/>
      <stop offset="0.7" stop-color="#7c5cff" stop-opacity="0.25"/>
      <stop offset="1" stop-color="#c4b5fd" stop-opacity="0.7"/>
    </linearGradient>
    <linearGradient id="orbitStroke" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a78bfa" stop-opacity="0.25"/>
      <stop offset="0.5" stop-color="#c4b5fd" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#7c5cff" stop-opacity="0.3"/>
    </linearGradient>
    <radialGradient id="glowA"><stop offset="0" stop-color="#c4b5fd" stop-opacity="0.6"/><stop offset="1" stop-color="#c4b5fd" stop-opacity="0"/></radialGradient>
    <radialGradient id="glowB"><stop offset="0" stop-color="#8b6dff" stop-opacity="0.6"/><stop offset="1" stop-color="#8b6dff" stop-opacity="0"/></radialGradient>
    <radialGradient id="glowC"><stop offset="0" stop-color="#e9e3ff" stop-opacity="0.6"/><stop offset="1" stop-color="#e9e3ff" stop-opacity="0"/></radialGradient>
    <linearGradient id="title" x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.42" stop-color="#ece6ff"/>
      <stop offset="0.5" stop-color="#ffffff"/>
      <stop offset="0.58" stop-color="#ece6ff"/>
      <stop offset="1" stop-color="#cfc2ff"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="1" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="diskFill" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0.3" stop-color="#ffffff"/>
      <stop offset="0.55" stop-color="#c9bbff"/>
      <stop offset="0.85" stop-color="#7c5cff" stop-opacity="0.6"/>
      <stop offset="1" stop-color="#5b3fd1" stop-opacity="0"/>
    </radialGradient>
    <filter id="blurXS" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2"/></filter>
    <filter id="blurS" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
    <filter id="blurM" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="blurL" x="-50%" y="-100%" width="200%" height="300%"><feGaussianBlur stdDeviation="9"/></filter>
  </defs>"""

PLANETS = [
    # (radius, color, duration in seconds, initial phase 0–1, brightness)
    [(6.5, "#c4b5fd", 11, 0.62, "glowA"), (4.2, "#e9e3ff", 11, 0.12, "glowC")],
    [(8.5, "#9b82ff", 17, 0.88, "glowB")],
    [(5.2, "#7f68d9", 8, 0.35, "glowB"), (4.6, "#dcd3ff", 8, 0.85, "glowC")],
]


def logo():
    W, H = 1200, 760
    cx, cy = 600, 290
    rng = random.Random(7)
    title, tw = SORA.path(NAME, 86, 600, 588, tracking=0.01)
    sub, _ = SORA_M.path(SUB, 21, 600, 640, tracking=0.32)
    tag, _ = SERIF_I.path(TAG, 34, 600, 698, tracking=0.01)
    sx0 = 600 - tw / 2
    orbits = [
        orbit(0, cx, cy, 330, 104, -17, PLANETS[0], 0.8),
        orbit(1, cx, cy, 268, 128, 28, PLANETS[1], 0.7),
        orbit(2, cx, cy, 205, 74, -4, PLANETS[2], 0.55),
    ]
    return f"""<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t d">
  <title id="t">{NAME.title()}</title>
  <desc id="d">{SUB.capitalize()}. {TAG}</desc>{DEFS}
  <clipPath id="card"><rect width="{W}" height="{H}" rx="40"/></clipPath>
  <g clip-path="url(#card)">
    <rect width="{W}" height="{H}" fill="url(#bg)"/>
    <rect width="{W}" height="{H}" fill="url(#nebula)"/>
    {stars(rng, 70, W, H, (cx, cy, 120))}
    {black_hole(cx, cy)}
    {orbits[2]}
    {orbits[1]}
    {orbits[0]}
    <path d="{title}" fill="url(#title)"/>
    <path d="{title}" fill="url(#shine)" opacity="0.55">
      <animate attributeName="opacity" values="0;0;0.55;0" keyTimes="0;0.55;0.75;1" dur="7s" repeatCount="indefinite"/>
    </path>
    <path d="{sub}" fill="#b6a6ff"/>
    <path d="{tag}" fill="#9a94b8"/>
  </g>
  <rect x="0.75" y="0.75" width="{W-1.5}" height="{H-1.5}" rx="39.5" fill="none" stroke="#a78bfa" stroke-opacity="0.16" stroke-width="1.5"/>
</svg>
""".replace('id="shine" x1="0" y1="0" x2="1" y2="0"',
            f'id="shine" x1="{sx0-200:.0f}" y1="0" x2="{sx0:.0f}" y2="0"').replace(
    '<stop offset="1" stop-color="#fff" stop-opacity="0"/>\n    </linearGradient>\n    <filter',
    f'<stop offset="1" stop-color="#fff" stop-opacity="0"/>\n      <animateTransform attributeName="gradientTransform" type="translate" values="0 0;0 0;{tw+260:.0f} 0;{tw+260:.0f} 0" keyTimes="0;0.55;0.8;1" dur="7s" repeatCount="indefinite"/>\n    </linearGradient>\n    <filter', 1)


def icon():
    S = 512
    c = S / 2
    rng = random.Random(3)
    k = 1.12
    orbits = [
        orbit(0, c, c, 226, 70, -20, [PLANETS[0][0]], 0.8),
        orbit(1, c, c, 186, 100, 32, PLANETS[1], 0.7),
        orbit(2, c, c, 150, 54, -6, [PLANETS[2][0]], 0.55),
    ]
    return f"""<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {S} {S}" width="{S}" height="{S}" role="img" aria-label="{NAME.title()}">{DEFS}
  <clipPath id="card"><rect width="{S}" height="{S}" rx="112"/></clipPath>
  <g clip-path="url(#card)">
    <rect width="{S}" height="{S}" fill="url(#bg)"/>
    <rect width="{S}" height="{S}" fill="url(#nebula)"/>
    {stars(rng, 26, S, S, (c, c, 90))}
    {black_hole(c, c, k)}
    {orbits[2]}
    {orbits[1]}
    {orbits[0]}
  </g>
</svg>
"""


os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT, "logo.svg"), "w").write(logo())
open(os.path.join(OUT, "icon.svg"), "w").write(icon())
for n in ("logo.svg", "icon.svg"):
    print(n, os.path.getsize(os.path.join(OUT, n)), "bytes")
