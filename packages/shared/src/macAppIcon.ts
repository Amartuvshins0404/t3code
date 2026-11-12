export const MAC_APP_ICON_SIZE = 1024;
export const MAC_APP_ICON_TILE_SIZE = 824;

const TILE_HALF = MAC_APP_ICON_TILE_SIZE / 2;
const CENTER = MAC_APP_ICON_SIZE / 2;
const TILE_INSET = (MAC_APP_ICON_SIZE - MAC_APP_ICON_TILE_SIZE) / 2;
const CORNER_EXTENT = 290;
const CORNER_EXPONENT = 3.35;
const SHADOW_OPACITY = 0.3;
const SHADOW_OFFSET_Y = 10;
const SHADOW_SIGMA = 10;
const BACKGROUND = { r: 0x18, g: 0x18, b: 0x1b };

export interface MacAppIconPixelFormat {
  readonly channelOrder: "rgba" | "bgra";
  readonly premultiplied: boolean;
}

function squircleDistance(x: number, y: number): number {
  const u = Math.max(0, Math.abs(x) - TILE_HALF + CORNER_EXTENT) / CORNER_EXTENT;
  const v = Math.max(0, Math.abs(y) - TILE_HALF + CORNER_EXTENT) / CORNER_EXTENT;
  if (u === 0 || v === 0) return Math.max(Math.abs(x), Math.abs(y)) - TILE_HALF;
  const un = Math.pow(u, CORNER_EXPONENT);
  const vn = Math.pow(v, CORNER_EXPONENT);
  const radius = Math.pow(un + vn, 1 / CORNER_EXPONENT);
  const gradient = Math.hypot(un / u, vn / v) / Math.pow(radius, CORNER_EXPONENT - 1);
  return ((radius - 1) * CORNER_EXTENT) / gradient;
}

function normalTail(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const erfc =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
    Math.exp(-(z * z) / 2);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}

export function composeMacAppIcon(tile: Uint8Array, format: MacAppIconPixelFormat): Uint8Array {
  if (tile.length !== MAC_APP_ICON_TILE_SIZE * MAC_APP_ICON_TILE_SIZE * 4) {
    throw new Error(
      `Expected a ${MAC_APP_ICON_TILE_SIZE}x${MAC_APP_ICON_TILE_SIZE} four-channel tile, got ${tile.length} bytes.`,
    );
  }
  const [first, third] =
    format.channelOrder === "rgba" ? [BACKGROUND.r, BACKGROUND.b] : [BACKGROUND.b, BACKGROUND.r];
  const background = [first, BACKGROUND.g, third];
  const output = new Uint8Array(MAC_APP_ICON_SIZE * MAC_APP_ICON_SIZE * 4);

  for (let py = 0; py < MAC_APP_ICON_SIZE; py++) {
    const y = py + 0.5 - CENTER;
    const rowInTile = py >= TILE_INSET && py < TILE_INSET + MAC_APP_ICON_TILE_SIZE;
    for (let px = 0; px < MAC_APP_ICON_SIZE; px++) {
      const x = px + 0.5 - CENTER;
      const inTile = rowInTile && px >= TILE_INSET && px < TILE_INSET + MAC_APP_ICON_TILE_SIZE;
      const shadowDistance = squircleDistance(x, y - SHADOW_OFFSET_Y);
      const shadow =
        shadowDistance > 4 * SHADOW_SIGMA
          ? 0
          : SHADOW_OPACITY * normalTail(shadowDistance / SHADOW_SIGMA);
      const coverage = inTile ? Math.min(1, Math.max(0, 0.5 - squircleDistance(x, y))) : 0;
      const alpha = coverage + shadow * (1 - coverage);
      const target = (py * MAC_APP_ICON_SIZE + px) * 4;
      output[target + 3] = Math.round(alpha * 255);
      if (coverage === 0) continue;

      const source = ((py - TILE_INSET) * MAC_APP_ICON_TILE_SIZE + (px - TILE_INSET)) * 4;
      const sourceAlpha = tile[source + 3]! / 255;
      const colorScale = format.premultiplied ? 1 : sourceAlpha;
      const outputScale = format.premultiplied ? coverage : coverage / alpha;
      for (let channel = 0; channel < 3; channel++) {
        const color =
          tile[source + channel]! * colorScale + background[channel]! * (1 - sourceAlpha);
        output[target + channel] = Math.round(color * outputScale);
      }
    }
  }
  return output;
}
