import { describe, expect, it } from "vite-plus/test";

import { composeMacAppIcon, MAC_APP_ICON_SIZE, MAC_APP_ICON_TILE_SIZE } from "./macAppIcon.ts";

const solidTile = (pixel: ReadonlyArray<number>) => {
  const tile = new Uint8Array(MAC_APP_ICON_TILE_SIZE * MAC_APP_ICON_TILE_SIZE * 4);
  for (let index = 0; index < tile.length; index += 4) tile.set(pixel, index);
  return tile;
};

const pixelAt = (icon: Uint8Array, x: number, y: number) => {
  const offset = (y * MAC_APP_ICON_SIZE + x) * 4;
  return [...icon.subarray(offset, offset + 4)];
};

describe("composeMacAppIcon", () => {
  it("draws the picture in a rounded tile with transparent margin and a shadow below", () => {
    const icon = composeMacAppIcon(solidTile([255, 0, 0, 255]), {
      channelOrder: "rgba",
      premultiplied: false,
    });

    expect(pixelAt(icon, 512, 512)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(icon, 0, 0)[3]).toBe(0);
    expect(pixelAt(icon, 105, 105)[3]).toBeLessThan(255);
    expect(pixelAt(icon, 512, 50)[3]).toBe(0);
    expect(pixelAt(icon, 512, 935)).toEqual([0, 0, 0, expect.any(Number)]);
    expect(pixelAt(icon, 512, 935)[3]).toBeGreaterThan(pixelAt(icon, 512, 89)[3]!);
  });

  it("fills transparent pictures with the tile background in the buffer's channel order", () => {
    const rgba = composeMacAppIcon(solidTile([0, 0, 0, 0]), {
      channelOrder: "rgba",
      premultiplied: false,
    });
    const bgra = composeMacAppIcon(solidTile([0, 0, 0, 0]), {
      channelOrder: "bgra",
      premultiplied: true,
    });

    expect(pixelAt(rgba, 512, 512)).toEqual([0x18, 0x18, 0x1b, 255]);
    expect(pixelAt(bgra, 512, 512)).toEqual([0x1b, 0x18, 0x18, 255]);
  });
});
