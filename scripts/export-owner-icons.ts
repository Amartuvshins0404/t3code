#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import sharp from "sharp";

import {
  BRAND_ASSET_PATHS,
  OWNER_ICON_DIRECTORY,
  OWNER_PLACEHOLDER_LOGO_PATH,
  resolveBrandAssetPath,
  resolveOwnerLogoPath,
  resolveWebIconOverrides,
  WEB_PUBLIC_DIRECTORY,
} from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";
import { loadRepoEnv } from "./lib/public-config.ts";

const MASTER_SIZE = 1024;
const MAC_BODY_SIZE = 824;
const MAC_BODY_INSET = 100;
const MAC_BODY_RADIUS = 185;
const ANDROID_ADAPTIVE_SIZE = 432;
const ANDROID_SPLASH_SIZE = 1152;
const ANDROID_NOTIFICATION_SIZE = 96;
const ANDROID_NOTIFICATION_CROP = 0.6;
const OPAQUE_BACKGROUND = "#18181B";
const PLACEHOLDER_ENV = {};

const CHANNEL_OUTPUTS = [
  {
    ios: BRAND_ASSET_PATHS.developmentIosIconPng,
    macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
    universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
    appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    webIcon192: BRAND_ASSET_PATHS.developmentWebIcon192Png,
    webIcon512: BRAND_ASSET_PATHS.developmentWebIcon512Png,
    favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    androidBackground: BRAND_ASSET_PATHS.androidIconBackgroundDevelopmentPng,
    androidSplash: BRAND_ASSET_PATHS.androidSplashIconDevelopmentPng,
  },
  {
    ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
    macos: BRAND_ASSET_PATHS.nightlyMacIconPng,
    universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
    appleTouch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
    webIcon192: BRAND_ASSET_PATHS.nightlyWebIcon192Png,
    webIcon512: BRAND_ASSET_PATHS.nightlyWebIcon512Png,
    favicon16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    androidBackground: BRAND_ASSET_PATHS.androidIconBackgroundNightlyPng,
    androidSplash: BRAND_ASSET_PATHS.androidSplashIconNightlyPng,
  },
  {
    ios: BRAND_ASSET_PATHS.productionIosIconPng,
    macos: BRAND_ASSET_PATHS.productionMacIconPng,
    universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
    appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    webIcon192: BRAND_ASSET_PATHS.productionWebIcon192Png,
    webIcon512: BRAND_ASSET_PATHS.productionWebIcon512Png,
    favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    androidBackground: undefined,
    androidSplash: BRAND_ASSET_PATHS.androidSplashIconProductionPng,
  },
] as const;

export class OwnerIconSourceError extends Schema.TaggedError<OwnerIconSourceError>()(
  "OwnerIconSourceError",
  { sourcePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read ${this.sourcePath} as a PNG, JPEG or SVG image.`;
  }
}

export class OwnerIconRenderError extends Schema.TaggedError<OwnerIconRenderError>()(
  "OwnerIconRenderError",
  { rendition: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to render the ${this.rendition} icon.`;
  }
}

export class OwnerIconsStaleError extends Schema.TaggedError<OwnerIconsStaleError>()(
  "OwnerIconsStaleError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Committed icons do not match ${OWNER_PLACEHOLDER_LOGO_PATH}. Run \`vp run icons:export\` with T3CODE_OWNER_LOGO unset:\n${this.paths.map((path) => `- ${path}`).join("\n")}`;
  }
}

const render = (rendition: string, build: () => Promise<Buffer>) =>
  Effect.tryPromise({
    try: build,
    catch: (cause) => new OwnerIconRenderError({ rendition, cause }),
  });

const loadMaster = Effect.fn("ownerIcons.loadMaster")(function* (
  repositoryRoot: string,
  sourcePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fs.readFile(path.resolve(repositoryRoot, sourcePath));
  return yield* Effect.tryPromise({
    try: () =>
      sharp(contents)
        .autoOrient()
        .resize(MASTER_SIZE, MASTER_SIZE, { fit: "cover" })
        .png()
        .toBuffer(),
    catch: (cause) => new OwnerIconSourceError({ sourcePath, cause }),
  });
});

const renderOutputs = Effect.fn("ownerIcons.renderOutputs")(function* (master: Buffer) {
  const resized = (size: number) =>
    render(`${size}px`, () => sharp(master).resize(size, size).png().toBuffer());
  const opaque = (size: number) =>
    render(`opaque ${size}px`, () =>
      sharp(master).flatten({ background: OPAQUE_BACKGROUND }).resize(size, size).png().toBuffer(),
    );
  const silhouette = (rendition: string, size: number, crop: number) =>
    render(rendition, async () => {
      const cropSize = Math.round(MASTER_SIZE * crop);
      const offset = Math.round((MASTER_SIZE - cropSize) / 2);
      const mask = await sharp(master)
        .flatten({ background: OPAQUE_BACKGROUND })
        .extract({ left: offset, top: offset, width: cropSize, height: cropSize })
        .greyscale()
        .threshold(128)
        .png()
        .toBuffer();
      const alpha = await sharp(mask).resize(size, size).toColourspace("b-w").png().toBuffer();
      return sharp({ create: { width: size, height: size, channels: 3, background: "#FFFFFF" } })
        .joinChannel(alpha)
        .png()
        .toBuffer();
    });
  const macos = render("macOS", async () => {
    const roundedMask = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${MAC_BODY_SIZE}" height="${MAC_BODY_SIZE}"><rect width="${MAC_BODY_SIZE}" height="${MAC_BODY_SIZE}" rx="${MAC_BODY_RADIUS}" fill="#FFFFFF"/></svg>`,
    );
    const body = await sharp(master)
      .resize(MAC_BODY_SIZE, MAC_BODY_SIZE)
      .composite([{ input: roundedMask, blend: "dest-in" }])
      .png()
      .toBuffer();
    return sharp(body)
      .extend({
        top: MAC_BODY_INSET,
        bottom: MAC_BODY_INSET,
        left: MAC_BODY_INSET,
        right: MAC_BODY_INSET,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  });

  const icoRenditions = yield* Effect.forEach(WINDOWS_ICON_SIZES, (size) =>
    resized(size).pipe(Effect.map((contents) => ({ size, contents }))),
  );
  const ico = yield* Effect.try({
    try: () => encodePngIco(icoRenditions),
    catch: (cause) => new OwnerIconRenderError({ rendition: "ICO", cause }),
  });
  const ios = yield* opaque(MASTER_SIZE);
  const mac = yield* macos;
  const appleTouch = yield* resized(180);
  const webIcon192 = yield* resized(192);
  const webIcon512 = yield* resized(512);
  const favicon16 = yield* resized(16);
  const favicon32 = yield* resized(32);
  const androidAdaptive = yield* opaque(ANDROID_ADAPTIVE_SIZE);
  const androidSplash = yield* opaque(ANDROID_SPLASH_SIZE);

  const generated = new Map<string, Buffer>([
    [BRAND_ASSET_PATHS.androidIconForegroundPng, androidAdaptive],
    [
      BRAND_ASSET_PATHS.androidIconMarkPng,
      yield* silhouette("Android monochrome", ANDROID_ADAPTIVE_SIZE, 1),
    ],
    [
      BRAND_ASSET_PATHS.androidNotificationIconPng,
      yield* silhouette(
        "Android notification",
        ANDROID_NOTIFICATION_SIZE,
        ANDROID_NOTIFICATION_CROP,
      ),
    ],
  ]);
  for (const outputs of CHANNEL_OUTPUTS) {
    generated.set(outputs.ios, ios);
    generated.set(outputs.macos, mac);
    generated.set(outputs.universal, master);
    generated.set(outputs.appleTouch, appleTouch);
    generated.set(outputs.webIcon192, webIcon192);
    generated.set(outputs.webIcon512, webIcon512);
    generated.set(outputs.favicon16, favicon16);
    generated.set(outputs.favicon32, favicon32);
    generated.set(outputs.faviconIco, ico);
    generated.set(outputs.windowsIco, ico);
    generated.set(outputs.androidSplash, androidSplash);
    if (outputs.androidBackground !== undefined) {
      generated.set(outputs.androidBackground, androidAdaptive);
    }
  }
  for (const override of resolveWebIconOverrides(
    "development",
    WEB_PUBLIC_DIRECTORY,
    PLACEHOLDER_ENV,
  )) {
    const contents = generated.get(override.sourceRelativePath);
    if (contents === undefined) {
      return yield* Effect.die(
        new Error(`Generated web icon is missing: ${override.sourceRelativePath}`),
      );
    }
    generated.set(override.targetRelativePath, contents);
  }
  return generated;
});

const isCurrent = Effect.fn("ownerIcons.isCurrent")(function* (
  repositoryRoot: string,
  relativePath: string,
  expected: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  if (!(yield* fs.exists(targetPath))) return false;
  return Buffer.from(yield* fs.readFile(targetPath)).equals(expected);
});

export const exportOwnerIcons = Effect.fn("exportOwnerIcons")(function* (checkOnly: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const env = checkOnly ? PLACEHOLDER_ENV : loadRepoEnv();
  const sourcePath = resolveOwnerLogoPath(env) ?? OWNER_PLACEHOLDER_LOGO_PATH;
  const master = yield* loadMaster(repositoryRoot, sourcePath);
  const generated = yield* renderOutputs(master);

  if (checkOnly) {
    const stale = yield* Effect.filter(
      [...generated.entries()],
      ([relativePath, contents]) =>
        isCurrent(repositoryRoot, relativePath, contents).pipe(Effect.map((current) => !current)),
      { concurrency: "unbounded" },
    );
    if (stale.length > 0) {
      return yield* new OwnerIconsStaleError({
        paths: stale.map(([relativePath]) => relativePath),
      });
    }
    yield* Console.log(`All ${generated.size} committed icons match ${sourcePath}.`);
    return;
  }

  yield* Effect.forEach(
    generated,
    ([relativePath, contents]) => {
      const targetPath = path.join(repositoryRoot, resolveBrandAssetPath(relativePath, env));
      return fs
        .makeDirectory(path.dirname(targetPath), { recursive: true })
        .pipe(Effect.andThen(fs.writeFile(targetPath, contents)));
    },
    { concurrency: "unbounded", discard: true },
  );
  yield* Console.log(
    `Wrote ${generated.size} icons from ${sourcePath} to ${
      resolveOwnerLogoPath(env) === undefined ? "the committed assets" : OWNER_ICON_DIRECTORY
    }.`,
  );
});

export const exportOwnerIconsCommand = Command.make(
  "export-owner-icons",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Verify the committed icons match the placeholder without writing."),
      Flag.withDefault(false),
    ),
  },
  ({ check }) => exportOwnerIcons(check),
).pipe(
  Command.withDescription(
    "Render every app icon from T3CODE_OWNER_LOGO, or from the placeholder when it is unset.",
  ),
);

if (import.meta.main) {
  Command.run(exportOwnerIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
