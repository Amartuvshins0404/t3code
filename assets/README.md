# App icons

Every app icon comes from one square image. By default that is `owner/placeholder.svg`, a dark rounded tile with a light "M". All three channels (dev, nightly, prod) use the same image; the per-channel file names under `dev/`, `nightly/` and `prod/` stay only so existing code keeps its paths.

Run `vp run icons:export` from the repository root to render every icon with `sharp`: web favicons and touch icons, the iOS, universal and Linux 1024 PNGs, the macOS 1024 PNG, the Windows `.ico`, and the Android launcher, splash, monochrome and notification images. It also copies the development web icons to `apps/web/public`. Run `vp run icons:check` to verify that the committed files match the placeholder. No Icon Composer, Xcode or other GUI tool is needed.

## Using your own picture

1. Set `T3CODE_OWNER_LOGO` in the root `.env` to a PNG or JPEG, absolute or relative to the repository root. A non-square image is centre-cropped.
2. Run `vp run icons:export`. The icons go to the gitignored `.owner-icons/` folder, which mirrors the repository paths, so nothing tracked changes.
3. Run or build as usual. The dev server, web build, desktop dev launcher, desktop packaging and mobile config read from `.owner-icons/` while the variable is set. Rerun the export after changing the image.

## Platform shapes

- iOS and the Android launcher, splash and background images are flattened onto the tile colour so they are opaque; the system applies its own mask. Keep the subject inside the central 60% so Android's circular mask does not crop it.
- The macOS PNG uses the classic safe area: an 824×824 rounded body inset 100 pixels on every side, transparent outside.
- The Android monochrome and notification images are white silhouettes of the image's light areas. The notification image uses the central 60%.

Do not edit the generated PNG or ICO files directly. `upstream/` holds the T3 Code GitHub App icon, which stays as GitHub shows it.
