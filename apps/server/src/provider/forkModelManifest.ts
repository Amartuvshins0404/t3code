import type { ModelManifestData } from "./ModelManifest.ts";

export const FORK_MODEL_MANIFEST_URL =
  "https://raw.githubusercontent.com/Amartuvshins0404/t3code/amaraa-mode/apps/server/src/provider/model-manifest.fork.json";

const updatedAtMs = (manifest: ModelManifestData) => {
  const parsed = manifest.updatedAt === undefined ? Number.NaN : Date.parse(manifest.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Adds the fork's models to upstream's list. Upstream entries stay unless the fork file is newer;
 * fork-only models come first, and a model upstream also lists is never shown twice.
 */
export function mergeForkModelManifest(
  base: ModelManifestData,
  fork: ModelManifestData,
): ModelManifestData {
  const forkWins = updatedAtMs(fork) > updatedAtMs(base);
  const providers = { ...base.providers };
  for (const [driver, overlay] of Object.entries(fork.providers ?? {})) {
    const upstream = providers[driver];
    if (upstream === undefined) {
      providers[driver] = overlay;
      continue;
    }
    const overlayBySlug = new Map(overlay.models.map((model) => [model.slug, model]));
    const upstreamSlugs = new Set(upstream.models.map((model) => model.slug));
    const defaults = forkWins ? (overlay.defaults ?? upstream.defaults) : upstream.defaults;
    providers[driver] = {
      ...(defaults === undefined ? {} : { defaults }),
      profiles: forkWins
        ? { ...upstream.profiles, ...overlay.profiles }
        : { ...overlay.profiles, ...upstream.profiles },
      models: [
        ...overlay.models.filter((model) => !upstreamSlugs.has(model.slug)),
        ...upstream.models.map((model) => (forkWins && overlayBySlug.get(model.slug)) || model),
      ],
    };
  }
  return {
    ...base,
    providers,
    currentModels: forkWins
      ? { ...base.currentModels, ...fork.currentModels }
      : { ...fork.currentModels, ...base.currentModels },
  };
}
