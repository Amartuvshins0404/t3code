import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import type * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";

import {
  codexCustomProviderEndpoint,
  withCodexCustomProviderModels,
} from "./codexProviderModels.ts";

const capabilities = (label: string) => ({
  optionDescriptors: [{ id: "reasoningEffort", label, type: "select" as const, options: [] }],
});

const model = (
  slug: string,
  overrides: Partial<ServerProviderModel> = {},
): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: capabilities(slug),
  ...overrides,
});

const draft = (models: ReadonlyArray<ServerProviderModel>) => ({
  enabled: true,
  installed: true,
  version: "0.169.0",
  status: "ready" as const,
  auth: { status: "authenticated" as const },
  checkedAt: "2026-11-18T00:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
});

const entry = (
  slug: string,
  name: string,
  overrides: Partial<ModelCatalog.ProviderCatalogModel> = {},
): ModelCatalog.ProviderCatalogModel => ({
  slug,
  name,
  status: "current",
  capabilities: null,
  adapter: undefined,
  profileAdapter: undefined,
  ...overrides,
});

const catalog: ModelCatalog.ProviderCatalog = {
  defaultChatModel: undefined,
  models: [
    entry("gpt-6.2-sol", "GPT-6.2 Sol"),
    entry("gpt-6.2-astra", "GPT-6.2 Astra", { badge: "new" }),
    entry("gpt-6.3-luna", "GPT-6.3 Luna"),
    entry("gpt-7-nova", "GPT-7 Nova"),
    entry("gpt-6-astra", "GPT-6 Astra", { status: "legacy" }),
  ],
};

describe("withCodexCustomProviderModels", () => {
  it("offers newer models the proxy serves and the catalog lists, with that line's settings", () => {
    const cli = [
      model("gpt-6.1-sol", { isDefault: true, aliases: ["sol"] }),
      model("gpt-6-astra"),
      model("gpt-6-luna"),
    ];
    const result = withCodexCustomProviderModels(draft(cli), catalog, [
      "gpt-6.2-sol",
      "gpt-6.2-astra",
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-6-chat-thinking",
      "gpt-image-2",
      "gpt-7-nova",
      "gpt-6.4-sol",
    ]);

    assert.deepStrictEqual(
      result.models.map((entry) => entry.slug),
      ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6.2-astra", "gpt-6-astra", "gpt-6-luna"],
    );
    const [sol, , astra] = result.models;
    assert.deepStrictEqual(sol, {
      slug: "gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      isCustom: false,
      capabilities: capabilities("gpt-6.1-sol"),
    });
    assert.deepStrictEqual(astra, {
      slug: "gpt-6.2-astra",
      name: "GPT-6.2 Astra",
      badge: "new",
      isCustom: false,
      capabilities: capabilities("gpt-6-astra"),
    });
  });

  it("adds nothing the proxy does not serve, so a down proxy changes nothing", () => {
    const cli = [model("gpt-6.1-sol"), model("gpt-6-astra"), model("gpt-6-luna")];
    for (const served of [[], ["gpt-6-astra"]]) {
      assert.deepStrictEqual(
        withCodexCustomProviderModels(draft(cli), catalog, served).models,
        cli,
      );
    }
  });

  it("leaves the list alone once the CLI lists the model itself", () => {
    const cli = [model("gpt-6.2-astra"), model("gpt-6-astra")];
    const result = withCodexCustomProviderModels(draft(cli), catalog, ["gpt-6.2-astra"]);
    assert.deepStrictEqual(
      result.models.map((entry) => entry.slug),
      ["gpt-6.2-astra", "gpt-6-astra"],
    );
  });
});

describe("codexCustomProviderEndpoint", () => {
  const proxyArgs =
    "-c model_provider=cliproxy -c model_providers.cliproxy.name=CLIProxyAPI -c model_providers.cliproxy.base_url=https://proxy.example/v1/ -c model_providers.cliproxy.env_key=CLIPROXY_API_KEY";

  it("reads the provider's address and key from the launch args and environment", () => {
    assert.deepStrictEqual(codexCustomProviderEndpoint(proxyArgs, { CLIPROXY_API_KEY: "k" }), {
      baseUrl: "https://proxy.example/v1",
      apiKey: "k",
    });
  });

  it("returns nothing without a key, or for OpenAI itself", () => {
    assert.strictEqual(codexCustomProviderEndpoint(proxyArgs, {}), null);
    assert.strictEqual(codexCustomProviderEndpoint("-c model_provider=openai", {}), null);
    assert.strictEqual(codexCustomProviderEndpoint("", { CLIPROXY_API_KEY: "k" }), null);
  });
});
