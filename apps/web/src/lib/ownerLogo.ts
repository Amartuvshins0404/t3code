import { OWNER_LOGO_MAX_LENGTH } from "@t3tools/contracts";

const OWNER_LOGO_SIZE = 256;
const OWNER_LOGO_PNG_MAX_LENGTH = 40_000;

function drawSquare(bitmap: ImageBitmap, background: string | null): HTMLCanvasElement | null {
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = OWNER_LOGO_SIZE;
  canvas.height = OWNER_LOGO_SIZE;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  if (background !== null) {
    context.fillStyle = background;
    context.fillRect(0, 0, OWNER_LOGO_SIZE, OWNER_LOGO_SIZE);
  }
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    OWNER_LOGO_SIZE,
    OWNER_LOGO_SIZE,
  );
  return canvas;
}

export async function readOwnerLogo(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (bitmap === null) return null;
  try {
    const png = drawSquare(bitmap, null)?.toDataURL("image/png");
    if (png !== undefined && png.length <= OWNER_LOGO_PNG_MAX_LENGTH) return png;
    const opaque = drawSquare(bitmap, "#ffffff");
    if (opaque === null) return null;
    for (const quality of [0.85, 0.6]) {
      const jpeg = opaque.toDataURL("image/jpeg", quality);
      if (jpeg.length <= OWNER_LOGO_MAX_LENGTH) return jpeg;
    }
    return null;
  } finally {
    bitmap.close();
  }
}
