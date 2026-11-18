import type { ServerProviderModel } from "@t3tools/contracts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { codexLaunchArgConfigValue, codexLaunchArgModelProvider } from "./codexLaunchArgs.ts";

const PROXY_MODELS_TIMEOUT = "4 seconds";
const CHAT_MODEL_SLUG = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/;

const ProxyModelList = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const decodeProxyModelList = Schema.decodeUnknownEffect(ProxyModelList);

/** The OpenAI-compatible endpoint a Codex instance's own model provider points at, when it names one. */
export function codexCustomProviderEndpoint(
  launchArgs: string | undefined,
  environment: NodeJS.ProcessEnv,
): { readonly baseUrl: string; readonly apiKey: string } | null {
  const provider = codexLaunchArgModelProvider(launchArgs);
  if (provider === undefined || provider === "openai") return null;
  const baseUrl = codexLaunchArgConfigValue(launchArgs, `model_providers.${provider}.base_url`);
  const envKey = codexLaunchArgConfigValue(launchArgs, `model_providers.${provider}.env_key`);
  const apiKey = envKey === undefined ? undefined : environment[envKey]?.trim();
  if (baseUrl === undefined || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

export const fetchCodexProviderModelSlugs = (
  endpoint: { readonly baseUrl: string; readonly apiKey: string } | null,
) =>
  endpoint === null
    ? Effect.succeed<ReadonlyArray<string>>([])
    : HttpClient.HttpClient.pipe(
        Effect.flatMap((http) =>
          http.execute(
            HttpClientRequest.get(`${endpoint.baseUrl}/models`).pipe(
              HttpClientRequest.bearerToken(endpoint.apiKey),
            ),
          ),
        ),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.flatMap(decodeProxyModelList),
        Effect.map((list): ReadonlyArray<string> => list.data.map((model) => model.id)),
        Effect.timeout(PROXY_MODELS_TIMEOUT),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );

const versionParts = (version: string) => version.split(".").map(Number);
const isNewerVersion = (left: string, right: string) => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

/**
 * With its own model provider, Codex lists only the models built into the installed CLI, so a
 * newer model the provider already serves stays hidden until the CLI updates. Offer a newer
 * model only when the provider serves it and the catalog lists it as current, borrowing settings
 * from the closest listed model of the same line (Astra, Sol, ...).
 */
export function withCodexCustomProviderModels(
  draft: ServerProviderDraft,
  catalog: ModelCatalog.ProviderCatalog | undefined,
  providerSlugs: ReadonlyArray<string>,
): ServerProviderDraft {
  const listed = new Set(draft.models.map((model) => model.slug));
  const served = new Set(providerSlugs);
  const candidates = (catalog?.models ?? []).filter(
    (entry) => entry.status === "current" && served.has(entry.slug),
  );
  const added = new Map<string, Array<ServerProviderModel>>();
  for (const entry of candidates) {
    const slug = entry.slug;
    const match = CHAT_MODEL_SLUG.exec(slug);
    if (listed.has(slug) || !match) continue;
    const [, version = "", line] = match;
    const template = draft.models
      .filter((model) => !model.isCustom && CHAT_MODEL_SLUG.exec(model.slug)?.[2] === line)
      .reduce<ServerProviderModel | undefined>((best, model) => {
        const modelVersion = CHAT_MODEL_SLUG.exec(model.slug)?.[1] ?? "";
        const bestVersion = best === undefined ? "" : (CHAT_MODEL_SLUG.exec(best.slug)?.[1] ?? "");
        return best === undefined || isNewerVersion(modelVersion, bestVersion) ? model : best;
      }, undefined);
    if (
      template === undefined ||
      !isNewerVersion(version, CHAT_MODEL_SLUG.exec(template.slug)?.[1] ?? "")
    ) {
      continue;
    }
    const {
      isDefault: _default,
      aliases: _aliases,
      badge: _badge,
      isLegacy: _legacy,
      shortName: _shortName,
      ...rest
    } = template;
    const model: ServerProviderModel = {
      ...rest,
      slug,
      name: entry.name,
      ...(entry.shortName ? { shortName: entry.shortName } : {}),
      ...(entry.badge ? { badge: entry.badge } : {}),
    };
    added.set(template.slug, [...(added.get(template.slug) ?? []), model]);
  }
  if (added.size === 0) return draft;
  return {
    ...draft,
    models: draft.models.flatMap((model) => [...(added.get(model.slug) ?? []), model]),
  };
}
