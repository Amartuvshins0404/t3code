#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalDate:off - A one-shot sync; plain Node APIs keep it small.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");
const UPSTREAM = "pingdotgg/t3code";
const MANIFEST_PATH = "apps/server/src/provider/model-manifest.json";
const OVERLAY_PATH = "apps/server/src/provider/model-manifest.fork.json";
const LOOKBACK_DAYS = 30;
const MAX_PAGES = 10;

interface Model {
  readonly slug: string;
  readonly profile?: string;
  readonly [key: string]: unknown;
}
interface Catalog {
  readonly profiles: Record<string, unknown>;
  readonly models: ReadonlyArray<Model>;
}
interface Manifest {
  readonly version: 1;
  readonly updatedAt?: string;
  readonly currentModels: Record<string, ReadonlyArray<string>>;
  readonly providers?: Record<string, Catalog>;
}
interface OpenPr {
  readonly number: number;
  readonly headRepository: { readonly nameWithOwner: string } | null;
  readonly headRefOid: string;
  readonly files: { readonly nodes: ReadonlyArray<{ readonly path: string }> };
}

const fetchManifest = async (repo: string, ref: string): Promise<Manifest | null> => {
  const response = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${MANIFEST_PATH}`);
  return response.ok ? ((await response.json()) as Manifest) : null;
};

const openModelPrs = (): ReadonlyArray<OpenPr> => {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const query = `query($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest {
        number headRefOid headRepository { nameWithOwner }
        files(first: 100) { nodes { path } }
      } }
    }
  }`;
  const prs: OpenPr[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args: ReadonlyArray<string> = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `q=repo:${UPSTREAM} is:pr is:open updated:>=${since}`,
      ...(after === null ? [] : ["-f", `after=${after}`]),
    ];
    const result: NodeChildProcess.SpawnSyncReturns<string> = NodeChildProcess.spawnSync(
      "gh",
      args,
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(`gh api failed: ${result.stderr}`);
    const search: {
      readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string };
      readonly nodes: ReadonlyArray<Partial<OpenPr>>;
    } = JSON.parse(result.stdout).data.search;
    prs.push(...search.nodes.filter((node): node is OpenPr => node.number !== undefined));
    if (!search.pageInfo.hasNextPage) break;
    after = search.pageInfo.endCursor;
  }
  return prs.filter((pr) => pr.files.nodes.some((file) => file.path === MANIFEST_PATH));
};

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const dateMs = (manifest: Manifest | undefined) => Date.parse(manifest?.updatedAt ?? "") || 0;

const main = await fetchManifest(UPSTREAM, "main");
if (main === null) throw new Error("Could not read upstream's model list.");
const overlayFile = NodePath.join(root, OVERLAY_PATH);
const previous = JSON.parse(NodeFS.readFileSync(overlayFile, "utf8")) as Manifest;

const models = new Map<string, Map<string, Model>>();
const profiles = new Map<string, Record<string, unknown>>();
const currentModels: Record<string, ReadonlyArray<string>> = {};
const lines: string[] = [];
let updatedAt = main.updatedAt ?? "";

const take = (driver: string, catalog: Catalog, model: Model) => {
  const driverModels = models.get(driver) ?? new Map<string, Model>();
  driverModels.set(model.slug, model);
  models.set(driver, driverModels);
  if (model.profile !== undefined && catalog.profiles[model.profile] !== undefined) {
    profiles.set(driver, {
      ...profiles.get(driver),
      [model.profile]: catalog.profiles[model.profile],
    });
  }
};

const prs = [...openModelPrs()];
const prManifests = await Promise.all(
  prs.map(async (pr) => ({
    pr,
    manifest:
      pr.headRepository === null
        ? null
        : await fetchManifest(pr.headRepository.nameWithOwner, pr.headRefOid),
  })),
);
prManifests.sort(
  (left, right) => dateMs(left.manifest ?? undefined) - dateMs(right.manifest ?? undefined),
);
for (const { pr, manifest } of prManifests) {
  if (manifest === null) continue;
  for (const [driver, catalog] of Object.entries(manifest.providers ?? {})) {
    const upstream = main.providers?.[driver]?.models ?? [];
    const added = catalog.models.filter(
      (model) => !upstream.some((entry) => entry.slug === model.slug),
    );
    // Other edits to a listed model can depend on code that PR has not merged yet.
    const retired = catalog.models.filter((model) => {
      const listed = upstream.find((entry) => entry.slug === model.slug);
      return (
        listed !== undefined &&
        !same(model, listed) &&
        same(model, { ...listed, status: model.status })
      );
    });
    if (added.length === 0) continue;
    const changed = [...added, ...retired];
    for (const model of changed) {
      take(driver, catalog, model);
      lines.push(`from upstream #${pr.number}: ${driver} ${model.slug} (${String(model.status)})`);
    }
    const current = manifest.currentModels[driver];
    if (current !== undefined) currentModels[driver] = current;
    if (manifest.updatedAt !== undefined && dateMs(manifest) > Date.parse(updatedAt)) {
      updatedAt = manifest.updatedAt;
    }
  }
}

for (const [driver, catalog] of Object.entries(previous.providers ?? {})) {
  const upstream = main.providers?.[driver]?.models ?? [];
  for (const model of catalog.models) {
    if (models.get(driver)?.has(model.slug)) continue;
    if (upstream.some((entry) => entry.slug === model.slug)) {
      lines.push(`upstream lists it now, dropped: ${driver} ${model.slug}`);
      continue;
    }
    take(driver, catalog, model);
    lines.push(`kept, no open upstream PR: ${driver} ${model.slug}`);
    if (currentModels[driver] === undefined && previous.currentModels[driver] !== undefined) {
      currentModels[driver] = previous.currentModels[driver];
    }
    if (dateMs(previous) > Date.parse(updatedAt)) updatedAt = previous.updatedAt ?? updatedAt;
  }
}

const next: Manifest = {
  version: 1,
  updatedAt,
  currentModels,
  providers: Object.fromEntries(
    [...models].map(([driver, driverModels]) => [
      driver,
      { profiles: profiles.get(driver) ?? {}, models: [...driverModels.values()] },
    ]),
  ),
};

const changed = !same(previous, next);
if (changed) {
  NodeFS.writeFileSync(overlayFile, `${JSON.stringify(next, null, 2)}\n`);
  NodeChildProcess.spawnSync("vp", ["fmt", OVERLAY_PATH], { cwd: root, stdio: "ignore" });
}
for (const line of lines) console.log(line);
console.log(
  changed
    ? `Updated ${OVERLAY_PATH}. Commit it to amaraa-mode; the app reads it within the hour, no release needed.`
    : `No change. Upstream main is from ${main.updatedAt ?? "an unknown date"}; ${prManifests.length} open upstream PR(s) touch the model list.`,
);
