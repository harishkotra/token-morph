/**
 * Turns an answer into particle target positions.
 *
 * The text is drawn into an offscreen 2D canvas, then pixels are sampled on a grid.
 * Every sampled point where the text has ink becomes one particle's target. The
 * result is normalised into a coordinate space centred on the origin, so a short
 * answer and a long one both fill the frame.
 */

export interface SampleResult {
  /** Flat [x, y, z] triples, one per sampled point. */
  positions: Float32Array;
  /** How many particles the text produced. */
  count: number;
  /** Normalised ink coverage of the sampled grid, 0..1. Useful as a density readout. */
  coverage: number;
  /** Width/height of the normalised layout, for camera framing. */
  width: number;
  height: number;
}

const FONT_STACK = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

/** Rough character budget for a single line before we hard-wrap. */
function wrapParagraph(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph.trim().length === 0) {
      lines.push('');
      continue;
    }

    // Preserve leading indentation (matters for ASCII art) and hang it on wraps.
    const indent = paragraph.match(/^\s*/)?.[0] ?? '';
    const words = paragraph.slice(indent.length).split(/(\s+)/);
    let current = indent;

    for (const word of words) {
      if (word.length === 0) continue;
      const candidate = current + word;
      if (ctx.measureText(candidate.trimEnd()).width > maxWidth && current.trim().length > 0) {
        lines.push(current.trimEnd());
        current = indent + word.trimStart();
      } else {
        current = candidate;
      }
    }
    lines.push(current.trimEnd());
  }

  return lines;
}

export interface SampleOptions {
  /** Sampling step in canvas pixels. Lower = more particles. */
  step?: number;
  /** Maximum particles the pool will accept. */
  maxParticles?: number;
  /** Canvas width in pixels. */
  width?: number;
  /** Canvas height in pixels. */
  height?: number;
}

export function sampleTextToParticles(text: string, options: SampleOptions = {}): SampleResult {
  const width = options.width ?? 1400;
  const height = options.height ?? 760;
  const step = options.step ?? 4;
  const maxParticles = options.maxParticles ?? 220_000;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { positions: new Float32Array(0), count: 0, coverage: 0, width: 0, height: 0 };
  }

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  const padding = 44;
  const maxTextWidth = width - padding * 2;
  const maxTextHeight = height - padding * 2;

  // Pick the largest font size that fits the answer. A one-word reply like "Paris"
  // would otherwise be a handful of pixels and read as an empty frame, while a long
  // answer needs to shrink to stay inside the canvas. Fitting the text to the frame
  // means every answer fills the cloud, whatever its length.
  let fontSize = 30;
  let lineHeight = Math.round(fontSize * 1.42);
  let lines: string[] = [];

  for (const candidate of [150, 120, 96, 76, 60, 48, 38, 30, 24, 19, 15, 12]) {
    ctx.font = `500 ${candidate}px ${FONT_STACK}`;
    const candidateLineHeight = Math.round(candidate * 1.42);
    const candidateLines = wrapParagraph(ctx, text, maxTextWidth);
    if (candidateLines.length * candidateLineHeight <= maxTextHeight) {
      fontSize = candidate;
      lineHeight = candidateLineHeight;
      lines = candidateLines;
      break;
    }
  }

  // If even the smallest size overflows, use it and let the tail clip.
  if (lines.length === 0) {
    fontSize = 12;
    lineHeight = Math.round(fontSize * 1.42);
    ctx.font = `500 ${fontSize}px ${FONT_STACK}`;
    lines = wrapParagraph(ctx, text, maxTextWidth);
  }

  ctx.font = `500 ${fontSize}px ${FONT_STACK}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#fff';

  // Centre the block, not each line: per-line centring would destroy the internal
  // alignment that ASCII art depends on.
  let widest = 0;
  for (const line of lines) {
    widest = Math.max(widest, ctx.measureText(line.trimEnd()).width);
  }
  const left = Math.max(padding, Math.round((width - widest) / 2));

  // Vertically centre the block of text.
  const blockHeight = lines.length * lineHeight;
  let y = Math.max(padding, Math.round((height - blockHeight) / 2));

  for (const line of lines) {
    ctx.fillText(line, left, y);
    y += lineHeight;
    if (y > height) break;
  }

  const image = ctx.getImageData(0, 0, width, height).data;

  // Sample on a grid, then adapt: a sparse layout (a tall column of digits, a single
  // short word) would otherwise yield a few hundred particles and read as a broken
  // frame. If the first pass comes back thin, resample on a finer grid so every
  // answer produces a cloud dense enough to see. The shape is unchanged — only the
  // resolution at which it is sampled.
  const MIN_PARTICLES = 2_500;

  const collect = (sampleStep: number) => {
    const outX: number[] = [];
    const outY: number[] = [];
    let sampledCount = 0;
    let inkedCount = 0;

    for (let py = 0; py < height; py += sampleStep) {
      for (let px = 0; px < width; px += sampleStep) {
        sampledCount += 1;
        const index = (py * width + px) * 4;
        // Red channel is enough: the text is white on black.
        if (image[index] > 110) {
          inkedCount += 1;
          if (outX.length < maxParticles) {
            outX.push(px);
            outY.push(py);
          }
        }
      }
    }
    return { outX, outY, sampledCount, inkedCount };
  };

  let pass = collect(step);

  if (pass.outX.length > 0 && pass.outX.length < MIN_PARTICLES) {
    // Inked pixels scale roughly with 1/step², so this lands close to the target.
    const ratio = Math.sqrt(pass.outX.length / MIN_PARTICLES);
    const finerStep = Math.max(1, Math.floor(step * ratio));
    if (finerStep < step) {
      pass = collect(finerStep);
    }
  }

  const { outX: xs, outY: ys, sampledCount: sampled, inkedCount: inked } = pass;

  const count = xs.length;
  if (count === 0) {
    return { positions: new Float32Array(0), count: 0, coverage: 0, width: 0, height: 0 };
  }

  // Normalise into a centred coordinate space with a fixed vertical extent, so the
  // camera framing does not change from run to run.
  const targetHeight = 24;
  const scale = targetHeight / height;

  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3 + 0] = (xs[i] - width / 2) * scale;
    // Canvas y grows downward; world y grows upward.
    positions[i * 3 + 1] = -(ys[i] - height / 2) * scale;
    // A shallow depth so the cloud reads as a volume under orbit, not a flat plane.
    positions[i * 3 + 2] = (((xs[i] * 7 + ys[i] * 13) % 100) / 100 - 0.5) * 1.6;
  }

  return {
    positions,
    count,
    coverage: sampled > 0 ? inked / sampled : 0,
    width: width * scale,
    height: targetHeight,
  };
}

/**
 * A deterministic pseudo-random point cloud, used to seed the particle pool before
 * the first layout so the scene is never empty on load.
 */
export function sampleScatterToParticles(count: number, spread = 30): Float32Array {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    // Hash-based, so the idle cloud looks the same on every load.
    const a = Math.sin(i * 12.9898) * 43758.5453;
    const b = Math.sin(i * 78.233) * 12345.6789;
    const c = Math.sin(i * 39.425) * 9876.5432;
    positions[i * 3 + 0] = (a - Math.floor(a) - 0.5) * spread;
    positions[i * 3 + 1] = (b - Math.floor(b) - 0.5) * spread * 0.5;
    positions[i * 3 + 2] = (c - Math.floor(c) - 0.5) * 6;
  }
  return positions;
}