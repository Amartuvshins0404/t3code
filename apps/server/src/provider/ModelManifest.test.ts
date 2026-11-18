import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { FORK_MODEL_MANIFEST_URL } from "./forkModelManifest.ts";
import * as ModelManifest from "./ModelManifest.ts";

describe("resolveProviderCatalog", () => {
  it.each([
    { releasedAt: "2026-01-01", now: "2026-01-01T00:00:00Z", badge: "new" },
    { releasedAt: "2026-01-01", now: "2026-01-07T23:59:59.999Z", badge: "new" },
    { releasedAt: "2026-01-01", now: "2026-01-08T00:00:00Z", badge: undefined },
    { releasedAt: "2026-01-01", now: "2026-02-01T00:00:00Z", badge: undefined },
    { releasedAt: "2026-01-02T00:00:00Z", now: "2026-01-01T00:00:00Z", badge: undefined },
    { releasedAt: undefined, now: "2026-01-01T00:00:00Z", badge: undefined },
    { releasedAt: "invalid", now: "2026-01-01T00:00:00Z", badge: undefined },
  ])("derives the new badge from releasedAt=$releasedAt at $now", ({ releasedAt, now, badge }) => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          profiles: {},
          models: [
            {
              slug: "model-next",
              name: "Model Next",
              status: "current",
              ...(releasedAt === undefined ? {} : { releasedAt }),
            },
            {
              slug: "model-legacy",
              name: "Model Legacy",
              status: "legacy",
              releasedAt: now,
            },
          ],
        },
      },
    };
    const catalog = ModelManifest.resolveProviderCatalog(
      manifest,
      ProviderDriverKind.make("synthetic"),
      Date.parse(now),
    );
    assert.strictEqual(catalog?.models[0]?.badge, badge);
    assert.strictEqual(catalog?.models[1]?.badge, undefined);
  });

  it.effect("expires badges when rereading a cached manifest without a refresh", () => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          profiles: {},
          models: [
            {
              slug: "model-next",
              name: "Model Next",
              status: "current",
              releasedAt: "1970-01-01T00:00:00Z",
            },
          ],
        },
      },
    };
    return Effect.gen(function* () {
      const service = yield* ModelCatalog.ModelCatalog;
      const readCatalog = service.current(ProviderDriverKind.make("synthetic"));
      assert.strictEqual((yield* readCatalog)?.models[0]?.badge, "new");
      yield* TestClock.adjust("7 days");
      assert.strictEqual((yield* readCatalog)?.models[0]?.badge, undefined);
    }).pipe(
      Effect.provide(
        ModelManifest.layerModelCatalog.pipe(
          Layer.provide(
            Layer.succeed(ModelManifest.ModelManifest, {
              current: Effect.succeed(manifest),
              refresh: Effect.die("Catalog reads must not refresh the manifest"),
              forceRefresh: Effect.die("Catalog reads must not refresh the manifest"),
              refreshOnDemand: Effect.die("Catalog reads must not refresh the manifest"),
              refreshInBackground: Effect.die("Catalog reads must not refresh the manifest"),
            }),
          ),
        ),
      ),
    );
  });

  it("rejects invalid catalog references", () => {
    const invalidCatalog = (input: {
      readonly models: NonNullable<ModelManifest.ModelManifestData["providers"]>[string]["models"];
      readonly defaultChat?: string;
    }): ModelManifest.ModelManifestData => ({
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          ...(input.defaultChat ? { defaults: { chat: input.defaultChat } } : {}),
          profiles: {},
          models: input.models,
        },
      },
    });

    for (const invalid of [
      invalidCatalog({
        models: [
          { slug: "duplicate", name: "First", status: "current" },
          { slug: "duplicate", name: "Second", status: "current" },
        ],
      }),
      invalidCatalog({
        models: [
          {
            slug: "missing-profile",
            name: "Missing Profile",
            status: "current",
            profile: "missing",
          },
        ],
      }),
      invalidCatalog({
        models: [{ slug: "present", name: "Present", status: "current" }],
        defaultChat: "absent",
      }),
    ]) {
      assert.isNull(
        ModelManifest.resolveProviderCatalog(invalid, ProviderDriverKind.make("synthetic")),
      );
    }
  });
});

const REMOTE_UPDATED_AT = "2099-01-01T00:00:00Z";

const REMOTE_MANIFEST: ModelManifest.ModelManifestData = {
  version: 1,
  updatedAt: REMOTE_UPDATED_AT,
  currentModels: {
    codex: ["remote-model"],
    claudeAgent: ["remote-agent-model"],
  },
};

const REMOTE_CLAUDE_MANIFEST: ModelManifest.ModelManifestData = {
  version: 1,
  updatedAt: REMOTE_UPDATED_AT,
  currentModels: {},
  providers: {
    claudeAgent: {
      profiles: {
        synthetic: {
          adapter: { claudeCode: { effortMap: { extreme: "high" } } },
        },
      },
      models: [
        {
          slug: "remote-only-model",
          name: "Remote Only Model",
          status: "current",
          profile: "synthetic",
        },
      ],
    },
  },
};

const remoteClaudeManifestWithCompatibility = (
  compatibility: unknown,
): ModelManifest.ModelManifestData => ({
  ...REMOTE_CLAUDE_MANIFEST,
  providers: {
    claudeAgent: {
      profiles: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.profiles,
      models: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models.map((model) => ({
        ...model,
        adapter: { claudeCode: compatibility },
      })),
    },
  },
});

const INVALID_REMOTE_MANIFESTS: ReadonlyArray<ModelManifest.ModelManifestData> = [
  {
    ...REMOTE_CLAUDE_MANIFEST,
    providers: {
      claudeAgent: {
        profiles: {
          synthetic: {
            adapter: { claudeCode: { effortMap: { extreme: 123 } } },
          },
        },
        models: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models,
      },
    },
  },
  {
    ...REMOTE_CLAUDE_MANIFEST,
    providers: {
      claudeAgent: {
        profiles: {},
        models: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models,
      },
    },
  },
  {
    ...REMOTE_CLAUDE_MANIFEST,
    providers: {
      claudeAgent: {
        profiles: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.profiles,
        models: [
          ...REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models,
          {
            slug: "remote-only-model",
            name: "Duplicate Remote Model",
            status: "current",
            profile: "synthetic",
          },
        ],
      },
    },
  },
  {
    ...REMOTE_CLAUDE_MANIFEST,
    providers: {
      claudeAgent: {
        defaults: { chat: "absent-model" },
        profiles: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.profiles,
        models: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models,
      },
    },
  },
  remoteClaudeManifestWithCompatibility({ minVersion: "2.x" }),
  remoteClaudeManifestWithCompatibility({ maxVersionExclusive: "2.x" }),
  remoteClaudeManifestWithCompatibility({
    minVersion: "2.2",
    maxVersionExclusive: "2.1",
  }),
];

const withBundledForkModels = (manifest: ModelManifest.ModelManifestData) =>
  ModelManifest.withForkModels(manifest, ModelManifest.BUNDLED_FORK_MODEL_MANIFEST);
const REMOTE_WITH_FORK = withBundledForkModels(REMOTE_MANIFEST);
const REMOTE_CLAUDE_WITH_FORK = withBundledForkModels(REMOTE_CLAUDE_MANIFEST);

const layerHttpClient = (handler: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url === FORK_MODEL_MANIFEST_URL ? new Response(null, { status: 404 }) : handler(),
        ),
      ),
    ),
  );

const layerService = (input: {
  readonly prefix: string;
  readonly response: () => Response;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
}) =>
  ServerConfig.layerTest(process.cwd(), { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest(input.settings ?? {})),
    Layer.provideMerge(layerHttpClient(input.response)),
  );

describe("ModelManifest service", () => {
  it.effect("prefers a fetched manifest over the bundle and caches it to disk", () =>
    Effect.gen(function* () {
      const service = yield* ModelManifest.make;
      const refreshed = yield* service.refresh;
      assert.deepStrictEqual(refreshed, REMOTE_WITH_FORK);

      const rebooted = yield* ModelManifest.make;
      assert.deepStrictEqual(yield* rebooted.current, REMOTE_WITH_FORK);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerService({
          prefix: "model-manifest-fetch-test",
          response: () => Response.json(REMOTE_MANIFEST),
        }),
      ),
    ),
  );

  it.effect(
    "ignores older remote edits without replacing the current manifest or disk cache",
    () => {
      let remote = { ...REMOTE_MANIFEST, updatedAt: "2000-01-01T00:00:00Z" };
      return Effect.gen(function* () {
        const service = yield* ModelManifest.make;
        assert.deepStrictEqual(yield* service.refresh, ModelManifest.BUNDLED_MODEL_MANIFEST);
        assert.deepStrictEqual(yield* service.current, ModelManifest.BUNDLED_MODEL_MANIFEST);

        remote = { ...REMOTE_MANIFEST, updatedAt: REMOTE_UPDATED_AT };
        assert.deepStrictEqual(yield* service.forceRefresh, REMOTE_WITH_FORK);
        remote = { ...REMOTE_MANIFEST, updatedAt: ModelManifest.BUNDLED_MODEL_MANIFEST.updatedAt! };
        assert.deepStrictEqual(yield* service.forceRefresh, REMOTE_WITH_FORK);
        const rebooted = yield* ModelManifest.make;
        assert.deepStrictEqual(yield* rebooted.current, REMOTE_WITH_FORK);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerService({
            prefix: "model-manifest-stale-fetch-test",
            response: () => Response.json(remote),
          }),
        ),
      );
    },
  );

  it.effect("preserves the last-good remote cache when later payloads are invalid", () => {
    let responseIndex = 0;
    const responses = [REMOTE_CLAUDE_MANIFEST, ...INVALID_REMOTE_MANIFESTS];

    return Effect.gen(function* () {
      const service = yield* ModelManifest.make;
      assert.deepStrictEqual(yield* service.refresh, REMOTE_CLAUDE_WITH_FORK);

      for (const _invalid of INVALID_REMOTE_MANIFESTS) {
        yield* TestClock.adjust("1 hour");
        responseIndex += 1;
        assert.deepStrictEqual(yield* service.refresh, REMOTE_CLAUDE_WITH_FORK);
      }

      const rebooted = yield* ModelManifest.make;
      assert.deepStrictEqual(yield* rebooted.current, REMOTE_CLAUDE_WITH_FORK);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerService({
          prefix: "model-manifest-last-good-test",
          response: () => Response.json(responses[responseIndex]),
        }),
      ),
    );
  });

  it.effect("refetches for an opened model picker after five minutes, not an hour", () => {
    let fetches = 0;
    return Effect.gen(function* () {
      const service = yield* ModelManifest.make;
      yield* service.refresh;
      yield* TestClock.adjust("4 minutes");
      yield* service.refreshOnDemand;
      assert.strictEqual(fetches, 1);

      yield* TestClock.adjust("1 minute");
      yield* service.refresh;
      assert.strictEqual(fetches, 1);
      yield* service.refreshOnDemand;
      assert.strictEqual(fetches, 2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerService({
          prefix: "model-manifest-on-demand-test",
          response: () => {
            fetches += 1;
            return Response.json(REMOTE_MANIFEST);
          },
        }),
      ),
    );
  });

  it.effect("drops a disk cache of a manifest older than the bundled one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const cachePath = path.join(config.stateDir, "model-manifest.json");
      const { updatedAt: _undated, ...undatedManifest } = REMOTE_MANIFEST;
      for (const stale of [
        undatedManifest,
        { ...REMOTE_MANIFEST, updatedAt: "2000-01-01T00:00:00Z" },
      ]) {
        yield* fs.writeFileString(
          cachePath,
          yield* ModelManifest.encodeManifestCache({ fetchedAtMs: 0, manifest: stale }),
        );
        const service = yield* ModelManifest.make;
        assert.deepStrictEqual(yield* service.current, ModelManifest.BUNDLED_MODEL_MANIFEST);
      }

      yield* fs.writeFileString(
        cachePath,
        yield* ModelManifest.encodeManifestCache({ fetchedAtMs: 0, manifest: REMOTE_MANIFEST }),
      );
      const later = yield* ModelManifest.make;
      assert.deepStrictEqual(yield* later.current, REMOTE_WITH_FORK);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerService({
          prefix: "model-manifest-newer-bundle-test",
          response: () => Response.json(REMOTE_MANIFEST),
        }),
      ),
    ),
  );

  it.effect(
    "adds the fork's models without doubles and keeps them when the fork file is offline",
    () => {
      const forkClaude = (updatedAt: string): ModelManifest.ModelManifestData => ({
        version: 1,
        updatedAt,
        currentModels: {},
        providers: {
          claudeAgent: {
            profiles: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.profiles,
            models: [
              { slug: "fork-model", name: "Fork Model", status: "current", profile: "synthetic" },
              {
                slug: "remote-only-model",
                name: "Remote Only Model",
                status: "legacy",
                profile: "synthetic",
              },
            ],
          },
        },
      });
      let upstream: unknown = REMOTE_CLAUDE_MANIFEST;
      let fork: unknown = forkClaude("2099-06-01T00:00:00Z");
      const claudeModels = (manifest: ModelManifest.ModelManifestData) =>
        manifest.providers?.claudeAgent?.models.map((model) => `${model.slug}:${model.status}`);
      return Effect.gen(function* () {
        const service = yield* ModelManifest.make;
        assert.deepStrictEqual(claudeModels(yield* service.refresh), [
          "fork-model:current",
          "remote-only-model:legacy",
        ]);

        fork = null;
        upstream = {
          ...REMOTE_CLAUDE_MANIFEST,
          updatedAt: "2100-01-01T00:00:00Z",
          providers: {
            claudeAgent: {
              ...REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!,
              models: [
                ...REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models,
                { slug: "fork-model", name: "Fork Model", status: "current", profile: "synthetic" },
              ],
            },
          },
        };
        assert.deepStrictEqual(claudeModels(yield* service.forceRefresh), [
          "remote-only-model:current",
          "fork-model:current",
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "model-manifest-fork-test" }).pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(ServerSettings.layerTest({})),
            Layer.provideMerge(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) => {
                  const body = request.url === FORK_MODEL_MANIFEST_URL ? fork : upstream;
                  return Effect.succeed(
                    HttpClientResponse.fromWeb(
                      request,
                      body === null ? new Response(null, { status: 503 }) : Response.json(body),
                    ),
                  );
                }),
              ),
            ),
          ),
        ),
      );
    },
  );

  it.effect("does not fetch when provider update checks are disabled", () =>
    Effect.gen(function* () {
      let fetchCount = 0;
      const service = yield* ModelManifest.make.pipe(
        Effect.provide(
          layerHttpClient(() => {
            fetchCount += 1;
            return Response.json(REMOTE_MANIFEST);
          }),
        ),
      );
      assert.deepStrictEqual(yield* service.refresh, ModelManifest.BUNDLED_MODEL_MANIFEST);
      assert.deepStrictEqual(yield* service.forceRefresh, ModelManifest.BUNDLED_MODEL_MANIFEST);
      assert.strictEqual(fetchCount, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerService({
          prefix: "model-manifest-optout-test",
          response: () => Response.json(REMOTE_MANIFEST),
          settings: { enableProviderUpdateChecks: false },
        }),
      ),
    ),
  );
});
