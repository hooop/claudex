/**
 * The Claudex header gallery.
 *
 * Pure geometry and colour, no rendering: the welcome screen animates the
 * selected equation with Ink, while a debate writes one canonical frame into
 * the terminal scrollback. Keeping both uses here prevents the animated and
 * frozen versions from drifting apart.
 */

export const HEADER_ROWS = 5;
export const HEADER_MAX_WIDTH = 96;
const BANDS = 10;
const RAMP = " ░▒▓█";
const TAU = Math.PI * 2;
const PLASMA_SPEED = 1.25;

// Default gradient for equation presets; the plasma uses an evolving, saturated
// full-spectrum palette while keeping every colour visible on black.
const COLOR_A: [number, number, number] = [0x6d, 0x5d, 0xfc];
const COLOR_B: [number, number, number] = [0xf4, 0x72, 0xb6];

export const HEADER_ANIMATIONS = [
  { id: "plasma", label: "Plasma psychédélique", staticT: 0 },
  { id: "interference", label: "Interférences", staticT: 0 },
  { id: "lorenz", label: "Attracteur de Lorenz", staticT: 5 },
  { id: "lissajous", label: "Courbes de Lissajous", staticT: 4 },
  { id: "rule110", label: "Automate Rule 110", staticT: 24 },
  { id: "perlin", label: "Bruit de Perlin", staticT: 7 },
  { id: "fibonacci", label: "Spirale de Fibonacci", staticT: 4 },
  { id: "weierstrass", label: "Fonction de Weierstrass", staticT: 2 },
  { id: "heat", label: "Équation de la chaleur", staticT: 12 },
] as const;

export type HeaderAnimationId = (typeof HEADER_ANIMATIONS)[number]["id"];
export type HeaderAnimation = (typeof HEADER_ANIMATIONS)[number];

export const DEFAULT_HEADER_ANIMATION: HeaderAnimationId = "plasma";

export interface HeaderBand {
  chars: string;
  color: string;
}

type Point = readonly [number, number];

interface BrailleCanvas {
  columns: number;
  pixelWidth: number;
  pixelHeight: number;
  cells: Uint8Array;
}

const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

export function getHeaderAnimation(id: HeaderAnimationId): HeaderAnimation {
  return HEADER_ANIMATIONS.find((animation) => animation.id === id) ?? HEADER_ANIMATIONS[0];
}

export function cycleHeaderAnimation(id: HeaderAnimationId, direction: -1 | 1): HeaderAnimationId {
  const current = HEADER_ANIMATIONS.findIndex((animation) => animation.id === id);
  const next = (current + direction + HEADER_ANIMATIONS.length) % HEADER_ANIMATIONS.length;
  return HEADER_ANIMATIONS[next]!.id;
}

function lerpColor(t: number): string {
  const [r1, g1, b1] = COLOR_A;
  const [r2, g2, b2] = COLOR_B;
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
  const [red, green, blue] =
    sector < 1
      ? [chroma, secondary, 0]
      : sector < 2
        ? [secondary, chroma, 0]
        : sector < 3
          ? [0, chroma, secondary]
          : sector < 4
            ? [0, secondary, chroma]
            : sector < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const offset = lightness - chroma / 2;
  return `#${[red, green, blue]
    .map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function safeColumns(width: number): number {
  const integer = Number.isFinite(width) ? Math.floor(width) : 80;
  return Math.max(1, Math.min(integer, HEADER_MAX_WIDTH));
}

function density(value: number): string {
  const index = Math.min(RAMP.length - 1, Math.floor(clamp(value) * RAMP.length));
  return RAMP[index]!;
}

function normalizeRow(row: string, columns: number): string {
  const characters = [...row].slice(0, columns);
  return characters.join("") + " ".repeat(Math.max(0, columns - characters.length));
}

function colorize(
  rows: readonly string[],
  columns: number,
  colorAt: (position: number, band: number, row: number) => string = lerpColor,
): HeaderBand[][] {
  const bandCount = Math.min(BANDS, columns);

  return Array.from({ length: HEADER_ROWS }, (_, y) => {
    const characters = [...normalizeRow(rows[y] ?? "", columns)];
    const bands: HeaderBand[] = [];

    for (let band = 0; band < bandCount; band++) {
      const start = Math.floor((band * columns) / bandCount);
      const end = Math.floor(((band + 1) * columns) / bandCount);
      const position = bandCount === 1 ? 0 : band / (bandCount - 1);
      bands.push({
        chars: characters.slice(start, end).join(""),
        color: colorAt(position, band, y),
      });
    }

    return bands;
  });
}

function psychedelicColorTarget(band: number, row: number, epoch: number) {
  const epochX = epoch * 101;
  const epochY = epoch * 59;
  return {
    hue: (hash2d(band * 2 + 17 + epochX, row * 2 + 41 + epochY) / 0xffff_ffff) * 360,
    saturation:
      0.76 + (hash2d(band * 3 + 71 + epochX, row * 3 + 23 + epochY) / 0xffff_ffff) * 0.18,
    lightness:
      0.58 + (hash2d(band * 5 + 13 + epochX, row * 5 + 97 + epochY) / 0xffff_ffff) * 0.1,
  };
}

function psychedelicColor(band: number, row: number, t: number): string {
  const phaseOffset = hash2d(band + 131, row + 197) / 0xffff_ffff;
  const colorTime = t / 12 + phaseOffset;
  const epoch = Math.floor(colorTime);
  const progress = colorTime - epoch;
  const blend = progress * progress * (3 - 2 * progress);
  const from = psychedelicColorTarget(band, row, epoch);
  const to = psychedelicColorTarget(band, row, epoch + 1);
  const hueDelta = ((to.hue - from.hue + 540) % 360) - 180;

  return hslToHex(
    from.hue + hueDelta * blend,
    from.saturation + (to.saturation - from.saturation) * blend,
    from.lightness + (to.lightness - from.lightness) * blend,
  );
}

function scalarFrame(columns: number, sample: (x: number, y: number) => number): string[] {
  return Array.from({ length: HEADER_ROWS }, (_, y) => {
    let row = "";
    for (let x = 0; x < columns; x++) row += density(sample(x, y));
    return row;
  });
}

function createCanvas(columns: number): BrailleCanvas {
  return {
    columns,
    pixelWidth: columns * 2,
    pixelHeight: HEADER_ROWS * 4,
    cells: new Uint8Array(columns * HEADER_ROWS),
  };
}

function plot(canvas: BrailleCanvas, x: number, y: number): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || px >= canvas.pixelWidth || py < 0 || py >= canvas.pixelHeight) return;

  const cellX = Math.floor(px / 2);
  const cellY = Math.floor(py / 4);
  const bit = BRAILLE_BITS[py % 4]![px % 2]!;
  const index = cellY * canvas.columns + cellX;
  canvas.cells[index] = canvas.cells[index]! | bit;
}

function toPixel(canvas: BrailleCanvas, [x, y]: Point): Point {
  return [
    ((clamp(x, -1, 1) + 1) / 2) * (canvas.pixelWidth - 1),
    (1 - (clamp(y, -1, 1) + 1) / 2) * (canvas.pixelHeight - 1),
  ];
}

function drawSegment(canvas: BrailleCanvas, from: Point, to: Point): void {
  const [x1, y1] = toPixel(canvas, from);
  const [x2, y2] = toPixel(canvas, to);
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))));

  for (let step = 0; step <= steps; step++) {
    const progress = step / steps;
    plot(canvas, x1 + (x2 - x1) * progress, y1 + (y2 - y1) * progress);
  }
}

function drawPolyline(canvas: BrailleCanvas, points: readonly Point[]): void {
  for (let index = 1; index < points.length; index++) {
    drawSegment(canvas, points[index - 1]!, points[index]!);
  }
}

function brailleRows(canvas: BrailleCanvas): string[] {
  return Array.from({ length: HEADER_ROWS }, (_, y) => {
    let row = "";
    for (let x = 0; x < canvas.columns; x++) {
      const mask = canvas.cells[y * canvas.columns + x]!;
      row += mask === 0 ? " " : String.fromCodePoint(0x2800 + mask);
    }
    return row;
  });
}

function psychedelicFrame(columns: number, t: number): string[] {
  const time = t * 0.065;
  const cosine = Math.cos(time * 0.31);
  const sine = Math.sin(time * 0.31);

  return scalarFrame(columns, (x, y) => {
    const nx = ((x + 0.5) / columns) * 2 - 1;
    const ny = ((y + 0.5) / HEADER_ROWS) * 2 - 1;
    const rotatedX = nx * cosine - ny * sine;
    const rotatedY = nx * sine + ny * cosine;
    const radius = Math.hypot(rotatedX * 1.35, rotatedY);
    const angle = Math.atan2(rotatedY, rotatedX);

    // Classic demoscene plasma: travelling sine fields interfere, then a
    // final sine folds their sum into dense, continuously morphing bands.
    const rings = Math.sin(radius * 13 - time * 1.7);
    const spiral = Math.sin(angle * 4 + radius * 9 + time * 1.1);
    const diagonal = Math.sin(rotatedX * 9 - rotatedY * 7 + time * 1.35);
    return 0.5 + 0.5 * Math.sin((rings + spiral + diagonal) * 1.55);
  });
}

function interferenceFrame(columns: number, t: number): string[] {
  return scalarFrame(columns, (x, y) => {
    const wave =
      Math.sin(x / 6 + t / 6) +
      Math.sin(y / 1.6 - t / 5) +
      Math.sin((x + y * 3) / 10 + t / 8);
    return (wave + 3) / 6;
  });
}

function lorenzFrame(columns: number, t: number): string[] {
  const canvas = createCanvas(columns);
  const points: Point[] = [];
  const offset = Math.floor(Math.abs(t) * 7) % 640;
  const pointCount = Math.max(900, columns * 16);
  const total = 1_100 + offset + pointCount;
  const dt = 0.008;
  let x = 0.1;
  let y = 0;
  let z = 0;

  for (let step = 0; step < total; step++) {
    const dx = 10 * (y - x);
    const dy = x * (28 - z) - y;
    const dz = x * y - (8 / 3) * z;
    x += dx * dt;
    y += dy * dt;
    z += dz * dt;

    if (step >= 1_100 + offset) points.push([x / 21, (z - 25) / 24]);
  }

  drawPolyline(canvas, points);
  return brailleRows(canvas);
}

function lissajousFrame(columns: number, t: number): string[] {
  const canvas = createCanvas(columns);
  const points: Point[] = [];
  const samples = Math.max(180, columns * 5);
  const phase = t * 0.035;

  for (let index = 0; index <= samples; index++) {
    const u = (index / samples) * TAU;
    points.push([0.92 * Math.sin(3 * u + phase), 0.82 * Math.sin(2 * u - phase * 0.45)]);
  }

  drawPolyline(canvas, points);
  return brailleRows(canvas);
}

function rule110Frame(columns: number, t: number): string[] {
  let cells = Array.from({ length: columns }, (_, x) => x === Math.max(0, columns - 4));
  const firstGeneration = 18 + (Math.floor(Math.abs(t) * 0.75) % 96);
  const rows: string[] = [];

  for (let generation = 0; generation < firstGeneration + HEADER_ROWS; generation++) {
    if (generation >= firstGeneration) rows.push(cells.map((alive) => (alive ? "#" : " ")).join(""));

    cells = cells.map((_, x) => {
      const left = cells[(x - 1 + columns) % columns] ? 1 : 0;
      const center = cells[x] ? 1 : 0;
      const right = cells[(x + 1) % columns] ? 1 : 0;
      const neighbourhood = left * 4 + center * 2 + right;
      return ((110 >> neighbourhood) & 1) === 1;
    });
  }

  return rows;
}

function hash2d(x: number, y: number): number {
  let hash = Math.imul(x, 374_761_393) + Math.imul(y, 668_265_263);
  hash = Math.imul(hash ^ (hash >>> 13), 1_274_126_177);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function fade(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function gradientDot(ix: number, iy: number, x: number, y: number): number {
  const angle = (hash2d(ix, iy) % 8) * (TAU / 8);
  return Math.cos(angle) * (x - ix) + Math.sin(angle) * (y - iy);
}

function perlin(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const sx = fade(x - x0);
  const sy = fade(y - y0);
  const top = gradientDot(x0, y0, x, y) * (1 - sx) + gradientDot(x0 + 1, y0, x, y) * sx;
  const bottom =
    gradientDot(x0, y0 + 1, x, y) * (1 - sx) + gradientDot(x0 + 1, y0 + 1, x, y) * sx;
  return top * (1 - sy) + bottom * sy;
}

function perlinFrame(columns: number, t: number): string[] {
  return scalarFrame(columns, (x, y) => {
    const driftX = t * 0.026;
    const driftY = t * 0.011;
    const broad = perlin(x * 0.075 + driftX, y * 0.46 + driftY);
    const detail = perlin(x * 0.15 - driftX * 0.6, y * 0.92 + driftY * 1.4);
    return 0.5 + broad * 0.72 + detail * 0.24;
  });
}

function fibonacciFrame(columns: number, t: number): string[] {
  const canvas = createCanvas(columns);
  const points: Point[] = [];
  const samples = Math.max(220, columns * 5);
  const rotation = t * 0.04;

  for (let index = 0; index <= samples; index++) {
    const theta = (index / samples) * 14;
    const radius = 0.055 * Math.exp(0.19 * theta);
    points.push([radius * Math.cos(theta + rotation), radius * Math.sin(theta + rotation) * 1.15]);
  }

  drawSegment(canvas, [0, 0], points[0]!);

  drawPolyline(canvas, points);
  // Mark the centre and the growing tip so the rotating spiral keeps a clear
  // orientation even at narrow widths.
  for (const point of [points[0], points.at(-1)]) {
    if (!point) continue;
    const [x, y] = toPixel(canvas, point);
    plot(canvas, x, y);
    plot(canvas, x + 1, y);
  }
  return brailleRows(canvas);
}

function weierstrassFrame(columns: number, t: number): string[] {
  const canvas = createCanvas(columns);
  const points: Point[] = [];
  const terms = 6;
  const amplitude = 0.52;
  const normalizer = (1 - amplitude ** terms) / (1 - amplitude);
  const phase = t * 0.012;

  for (let x = 0; x < canvas.pixelWidth; x++) {
    const normalizedX = x / Math.max(1, canvas.pixelWidth - 1);
    let value = 0;
    for (let n = 0; n < terms; n++) {
      value += amplitude ** n * Math.cos(3 ** n * Math.PI * (normalizedX * 2 - 1 + phase));
    }
    points.push([normalizedX * 2 - 1, (value / normalizer) * 0.82]);
  }

  drawPolyline(canvas, points);
  return brailleRows(canvas);
}

function heatFrame(columns: number, t: number): string[] {
  const age = ((t * 0.028) % 1 + 1) % 1;
  const sources = [
    [0.27, 0.3],
    [0.73, 0.7],
  ] as const;

  return scalarFrame(columns, (x, y) => {
    const nx = (x + 0.5) / columns;
    const ny = (y + 0.5) / HEADER_ROWS;
    let temperature = 0;

    // Previous injections remain as a faint, broad background while the newest
    // two hot spots diffuse. This is the heat kernel, sampled periodically.
    for (let cycle = 0; cycle < 3; cycle++) {
      const elapsed = age + cycle;
      const variance = 0.004 + elapsed * 0.038;
      const decay = Math.exp(-elapsed * 1.35) / (1 + elapsed * 0.7);
      for (const [sourceX, sourceY] of sources) {
        const distance = (nx - sourceX) ** 2 + (ny - sourceY) ** 2;
        temperature += decay * Math.exp(-distance / (2 * variance));
      }
    }

    return temperature * 0.9;
  });
}

function rawFrame(columns: number, t: number, animation: HeaderAnimationId): string[] {
  switch (animation) {
    case "plasma":
      return psychedelicFrame(columns, t);
    case "interference":
      return interferenceFrame(columns, t);
    case "lorenz":
      return lorenzFrame(columns, t);
    case "lissajous":
      return lissajousFrame(columns, t);
    case "rule110":
      return rule110Frame(columns, t);
    case "perlin":
      return perlinFrame(columns, t);
    case "fibonacci":
      return fibonacciFrame(columns, t);
    case "weierstrass":
      return weierstrassFrame(columns, t);
    case "heat":
      return heatFrame(columns, t);
  }
}

/** One deterministic frame, split into stable colour bands for efficient Ink rendering. */
export function headerFrame(
  width: number,
  t: number,
  animation: HeaderAnimationId = DEFAULT_HEADER_ANIMATION,
): HeaderBand[][] {
  const columns = safeColumns(width);
  const frameT = animation === "plasma" ? t * PLASMA_SPEED : t;
  const colorAt =
    animation === "plasma"
      ? (_position: number, band: number, row: number) => psychedelicColor(band, row, frameT)
      : lerpColor;
  return colorize(rawFrame(columns, frameT, animation), columns, colorAt);
}
