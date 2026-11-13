#!/usr/bin/env python3
"""Build the README diagram: an exploded axonometric view of Claudex, light and dark.

Writes claudex-exploded.html and claudex-exploded-dark.html (editable sources, with
their paper background) and claudex-diagram-light.png / claudex-diagram-dark.png
(2x, transparent background, so GitHub's page colour shows through).

The geometry comes from the diagram-design plugin's exploded-view builder, which
this script imports rather than copies; the PNGs are screenshots from headless
Chrome. Neither is a Claudex dependency: this is maintainer tooling only.

    python3 docs/diagram/build.py

Environment:
    DIAGRAM_DESIGN_SCRIPTS  the plugin's scripts/ folder (default: newest installed)
    CHROME                  Chrome binary (default: the macOS app path)

After a rebuild, check the geometry with the plugin's verifier:
    python3 "$DIAGRAM_DESIGN_SCRIPTS/verify-exploded.py" docs/diagram/claudex-exploded*.html
"""
import importlib.util
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def plugin_scripts() -> Path:
    env = os.environ.get("DIAGRAM_DESIGN_SCRIPTS")
    if env:
        return Path(env)
    root = Path.home() / ".claude/plugins/cache/diagram-design/diagram-design"
    versions = sorted(root.glob("*/scripts"), key=lambda p: [int(n) if n.isdigit() else n for n in p.parent.name.split(".")])
    if not versions:
        sys.exit("diagram-design plugin not found; set DIAGRAM_DESIGN_SCRIPTS to its scripts/ folder")
    return versions[-1]


PLUGIN = plugin_scripts()
sys.path.insert(0, str(PLUGIN))
spec = importlib.util.spec_from_file_location("bx", PLUGIN / "build-exploded-examples.py")
if spec is None or spec.loader is None:
    sys.exit(f"cannot load build-exploded-examples.py from {PLUGIN}")
bx = importlib.util.module_from_spec(spec)
sys.modules["bx"] = bx
spec.loader.exec_module(bx)
from axonometry import FONT_LINK, MINIMAL, SKINS, Rect, outline, prism  # noqa: E402

def skin(paper, ink, ink_rgb, muted, soft, accent, acc_rgb, base, dark, claude, codex, screen):
    if dark:
        shade = (f"rgba({ink_rgb},0.10)", None, "rgba(10,9,16,0.45)")
        focal = (f"rgba({acc_rgb},0.18)", None, "rgba(10,9,16,0.45)")
        cavity, floor, well = "rgba(10,9,16,0.55)", "rgba(10,9,16,0.25)", "rgba(10,9,16,0.40)"
        inner, inner_acc = f"rgba({ink_rgb},0.45)", f"rgba({acc_rgb},0.70)"
    else:
        shade = (None, f"rgba({ink_rgb},0.07)", f"rgba({ink_rgb},0.15)")
        focal = (f"rgba({acc_rgb},0.10)", f"rgba({acc_rgb},0.20)", f"rgba({acc_rgb},0.32)")
        cavity, floor, well = f"rgba({ink_rgb},0.10)", f"rgba({ink_rgb},0.04)", f"rgba({ink_rgb},0.14)"
        inner, inner_acc = f"rgba({ink_rgb},0.55)", f"rgba({acc_rgb},0.70)"
    return dict(paper=paper, ink=ink, muted=muted, soft=soft, accent=accent, ink_rgb=ink_rgb, acc_rgb=acc_rgb,
                base=base, rule=f"rgba({ink_rgb},0.12)", shade=shade, focal=focal, cavity=cavity, floor=floor,
                well=well, screen=screen, island="#111111", chip_top=soft, chip_side=screen, sil=ink, inner=inner,
                trace=f"rgba({ink_rgb},0.30)", lead=f"rgba({ink_rgb},0.40)", lead_acc=f"rgba({acc_rgb},0.60)",
                inner_acc=inner_acc, lens=screen, lens_ring=f"rgba({ink_rgb},0.35)", claude=claude, codex=codex)


SKINS["claudex-light"] = skin("#f7f6fb", "#1f1b2e", "31,27,46", "#4a4560", "#5a5470", "#6a3fd0", "106,63,208",
                              "#ffffff", False, "#e0604e", "#1aa3b8", "#1f1b2e")
SKINS["claudex-dark"] = skin("#15131d", "#f2f0f8", "242,240,248", "#b8b3cc", "#9a94b0", "#a78bfa", "167,139,250",
                             "#24212f", True, "#ff8787", "#8be9f5", "#0b0a10")


def agent_detail(color_key):
    def detail(P, r, z, sk, focal):
        # A raised badge in the agent's own colour: the only place the two agent tones appear.
        cx, cy = r.x0 + 30, (r.y0 + r.y1) / 2
        badge = Rect(cx - 16, cy - 16, cx + 16, cy + 16, 16)
        c = prism(P, badge, z, z + 6)
        out = [f'<path d="{c["sil"]}" fill="{sk["chip_side"]}"/>', f'<path d="{c["top"]}" fill="{sk[color_key]}"/>']
        for i, w in enumerate((76, 96, 60)):
            ly = r.y0 + 18 + i * 14
            out.append(f'<path d="{outline(P, Rect(r.x0 + 58, ly, r.x0 + 58 + w, ly + 4, 0), z)}" fill="rgba({sk["ink_rgb"]},0.28)"/>')
        return out
    return detail


def terminal_detail(P, r, z, sk, focal):
    # A transcript: each turn starts with a rail in its author's colour.
    screen = r.inset(8)
    out = [f'<path d="{outline(P, screen, z)}" fill="{sk["screen"]}"/>']
    x0, y0 = screen.x0 + 14, screen.y0 + 14
    rows = (("claude", 96), (None, 72), ("codex", 104), (None, 56), ("claude", 84), (None, 0))
    for i, (who, w) in enumerate(rows):
        ly = y0 + i * 22
        if who:
            out.append(f'<path d="{outline(P, Rect(x0, ly, x0 + 6, ly + 6, 0), z)}" fill="{sk[who]}"/>')
        if w:
            out.append(f'<path d="{outline(P, Rect(x0 + 14, ly + 1, x0 + 14 + w, ly + 5, 0), z)}" fill="rgba(242,240,248,0.45)"/>')
        else:
            out.append(f'<path d="{outline(P, Rect(x0 + 14, ly - 2, x0 + 20, ly + 8, 0), z)}" fill="rgba(242,240,248,0.85)"/>')
    return out


def mini(P, rect, z0, z1, sk, top):
    c = prism(P, rect, z0, z1)
    return [f'<path d="{c["sil"]}" fill="{sk["base"]}"/>', f'<path d="{c["right"]}" fill="rgba({sk["ink_rgb"]},0.15)"/>',
            f'<path d="{c["left"]}" fill="rgba({sk["ink_rgb"]},0.07)"/>', f'<path d="{c["top"]}" fill="{top}"/>',
            f'<path d="{c["sil"]}" fill="none" stroke="{sk["sil"]}" stroke-width="0.8" stroke-linejoin="round"/>']


def project_detail(P, r, z, sk, focal):
    # Files on the left, a padlock dial for read-only, and the memory block at the front.
    out = [f'<path d="{outline(P, r.inset(12), z)}" fill="none" stroke="{sk["inner"]}" stroke-width="0.8"/>']
    for i, w in enumerate((64, 84, 52, 72, 44)):
        ly = r.y0 + 26 + i * 16
        out.append(f'<path d="{outline(P, Rect(r.x0 + 24, ly, r.x0 + 24 + w, ly + 4, 0), z)}" fill="rgba({sk["ink_rgb"]},0.28)"/>')
    lock = Rect(r.x1 - 58, r.y0 + 22, r.x1 - 26, r.y0 + 54, 16)
    out += mini(P, lock, z, z + 6, sk, sk["base"])
    out.append(f'<path d="{outline(P, lock.inset(8), z + 6)}" fill="none" stroke="{sk["inner"]}" stroke-width="0.8"/>')
    out.append(f'<path d="{outline(P, Rect(lock.x0 + 13, lock.y0 + 13, lock.x1 - 13, lock.y1 - 13, 3), z + 6)}" fill="{sk["chip_top"]}"/>')
    mem = prism(P, Rect(r.x1 - 76, r.y1 - 64, r.x1 - 24, r.y1 - 24, 3), z, z + 8)
    out += [f'<path d="{mem["sil"]}" fill="{sk["chip_side"]}"/>', f'<path d="{mem["top"]}" fill="{sk["chip_top"]}"/>']
    return out


bx.AI_DETAIL.update(claude=agent_detail("claude"), codex=agent_detail("codex"),
                    terminal=terminal_detail, orchestrator=bx.harness_detail, project=project_detail)

S = 180


def parts():
    P = bx.Part
    return [P("project", "Your project", "read-only during the debate", Rect(0, 0, S, S, 12), t=16, kind="project"),
            P("claude", "Claude Code", "agent by anthropic", Rect(12, 12, S - 12, 76, 6), t=12, kind="claude", level=1),
            P("codex", "Codex", "agent by openai", Rect(12, 104, S - 12, S - 12, 6), t=12, kind="codex", level=1),
            P("orchestrator", "Claudex", "relays answers until both agree", Rect(0, 0, S, S, 12), t=16, kind="orchestrator"),
            P("terminal", "Terminal", "you follow and step in", Rect(0, 0, S, S, 12), t=10, kind="terminal")]


TITLE = "Claudex · Two agents, one supervised debate"
DESC = ("Exploded view of Claudex: your project at the base stays read-only, Claude Code and Codex sit side by side above it, "
        "Claudex relays their answers until both agree, and the terminal on top is where you follow and step in.")

CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
PNG_NAMES = {"": "claudex-diagram-light.png", "-dark": "claudex-diagram-dark.png"}


def export_png(html: str, png: Path) -> None:
    """Screenshot the bare SVG at 2x with no backdrop, so the PNG is transparent."""
    svg = html[html.index("<svg"):html.rindex("</svg>") + 6]
    svg = re.sub(r'<rect width="100%" height="100%" fill="[^"]+"/>', "", svg, count=1)
    m = re.search(r'viewBox="0 0 1000 (\d+)"', svg)
    if m is None:
        sys.exit("unexpected viewBox in the generated SVG")
    vh = int(m.group(1))
    page = HERE / f".{png.stem}.tmp.html"
    page.write_text(f'<!DOCTYPE html><html><head><meta charset="utf-8"><link href="{FONT_LINK}" rel="stylesheet">'
                    f'<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:1000px;height:{vh}px}}</style>'
                    f'</head><body>{svg}</body></html>', encoding="utf-8")
    try:
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--window-size=1000,{vh}",
                        "--force-device-scale-factor=2", "--virtual-time-budget=5000",
                        "--default-background-color=00000000", f"--screenshot={png}", f"file://{page}"],
                       capture_output=True, check=True)
    finally:
        page.unlink(missing_ok=True)


for variant, sk_name in (("", "claudex-light"), ("-dark", "claudex-dark")):
    slug = f"claudex-exploded{variant}"
    fig = bx.Figure(slug=slug, title=TITLE, desc=DESC, parts=parts(), focus="orchestrator", gap_k=1.0)
    body, vh, _ = bx.build_svg(fig, sk_name, False, slug)
    sk = SKINS[sk_name]
    html = MINIMAL.format(eyebrow="Claudex · how it fits together", title=TITLE, font=FONT_LINK, slug=slug, desc=DESC,
                          vh=vh, body=body, **{k: sk[k] for k in ("paper", "ink", "muted", "accent")})
    (HERE / f"{slug}.html").write_text(html, encoding="utf-8")
    export_png(html, HERE / PNG_NAMES[variant])
    print("wrote", f"{slug}.html", PNG_NAMES[variant])
