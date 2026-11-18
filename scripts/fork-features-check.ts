#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot check; synchronous Node APIs keep it small.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");

const FORK_FEATURES: ReadonlyArray<{
  readonly name: string;
  readonly tests: ReadonlyArray<string>;
}> = [
  {
    name: "Owner name and icons",
    tests: [
      "packages/shared/src/macAppIcon.test.ts",
      "apps/server/src/device/DeviceService.test.ts",
    ],
  },
  {
    name: "Desktop app runs beside upstream and updates from fork releases",
    tests: [
      "apps/desktop/src/app/DesktopAppIdentity.test.ts",
      "apps/desktop/src/app/DesktopEnvironment.test.ts",
      "apps/desktop/src/updates/DesktopUpdates.test.ts",
      "apps/server/src/cli/update.test.ts",
      "apps/server/src/cloud/selfUpdate.test.ts",
    ],
  },
  {
    name: "Self-hosted sign-in and relay",
    tests: [
      "infra/auth/src/auth.test.ts",
      "infra/auth/src/cors.test.ts",
      "infra/relay/src/auth/identity.test.ts",
      "apps/desktop/src/app/DesktopLaunchLinks.test.ts",
      "apps/mobile/src/features/cloud/CloudAuthProvider.test.ts",
    ],
  },
  {
    name: "CLI Proxy providers",
    tests: [
      "apps/server/src/usage/cliproxyApi.test.ts",
      "apps/server/src/usage/UsageLimitSources.test.ts",
    ],
  },
  {
    name: "Fork tables open and upgrade without upstream migration ids",
    tests: ["apps/server/src/persistence/Migrations.test.ts"],
  },
  {
    name: "Teams: shared machines, threads, projects, proxy and agents",
    tests: [
      "apps/server/src/team/TeamAgent.test.ts",
      "apps/server/src/team/TeamMemberAccess.test.ts",
      "apps/server/src/team/TeamProjects.test.ts",
      "apps/server/src/team/TeamProviderRoutes.test.ts",
      "apps/server/src/team/TeamSharing.test.ts",
      "apps/server/src/team/sharedOrganizations.test.ts",
      "apps/server/src/orchestration-v2/teamShareAtCreation.test.ts",
      "apps/server/src/auth/RpcAuthorization.test.ts",
      "infra/relay/src/auth/TeamMembership.test.ts",
      "infra/relay/src/teams/TeamConnectivityLock.test.ts",
      "packages/client-runtime/src/cloudAuth/cloudTeams.test.ts",
      "packages/client-runtime/src/relay/teamWorkspace.test.ts",
      "packages/client-runtime/src/rpc/teammateConfig.test.ts",
    ],
  },
  {
    name: "Projects board and agent-trust planting",
    tests: [
      "apps/server/src/project/projectBoard.test.ts",
      "packages/client-runtime/src/state/projectBoard.test.ts",
      "apps/server/src/project/ProjectPlant.test.ts",
      "apps/server/src/project/ProjectPlant.repeat.test.ts",
      "apps/server/src/project/ProjectPlant.store.test.ts",
      "apps/server/src/mcp/toolkits/project/handlers.plant.test.ts",
      "apps/web/src/components/projectPlant/ProjectPlantButton.logic.test.ts",
    ],
  },
  {
    name: "Recommended answers send themselves",
    tests: ["apps/server/src/orchestration-v2/QuestionAutoAnswerWorker.test.ts"],
  },
  {
    name: "Master agent thread",
    tests: [
      "apps/server/src/masterAgent/MasterAgentWatch.test.ts",
      "apps/server/src/mcp/toolkits/core.test.ts",
      "apps/mobile/src/state/master-agent-threads.test.ts",
    ],
  },
  {
    name: "Code map",
    tests: [
      "apps/server/src/codemap/Codemap.test.ts",
      "apps/server/src/codemap/analyze.test.ts",
      "apps/web/src/components/codemap/codemapTreemap.logic.test.ts",
      "apps/web/src/components/codemap/codemapChanges.logic.test.ts",
    ],
  },
  {
    name: "New models reach the owner without upstream or a release",
    tests: [
      "apps/server/src/provider/ModelManifest.test.ts",
      "apps/server/src/provider/codexProviderModels.test.ts",
    ],
  },
  {
    name: "Cloning a repo already on disk opens it",
    tests: ["apps/server/src/sourceControl/SourceControlRepositoryService.test.ts"],
  },
];

const packageRoot = (file: string) => {
  let dir = NodePath.dirname(NodePath.join(root, file));
  while (dir !== root && !NodeFS.existsSync(NodePath.join(dir, "package.json"))) {
    dir = NodePath.dirname(dir);
  }
  return dir;
};

const env = { ...process.env };
delete env.T3CODE_OWNER_NAME;

const run = (command: string, cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

const failures: string[] = [];

const icons = run("node", root, ["scripts/export-owner-icons.ts", "--check"]);
console.log(`${icons.status === 0 ? "ok  " : "FAIL"} Committed icons match the owner image`);
if (icons.status !== 0) failures.push(`icons: ${icons.stdout}${icons.stderr}`);

for (const feature of FORK_FEATURES) {
  const missing = feature.tests.filter((file) => !NodeFS.existsSync(NodePath.join(root, file)));
  const byPackage = Map.groupBy(
    feature.tests.filter((file) => !missing.includes(file)),
    packageRoot,
  );
  const failed = [...byPackage].flatMap(([cwd, files]) => {
    const result = run("vp", cwd, [
      "test",
      "run",
      ...files.map((file) => NodePath.relative(cwd, NodePath.join(root, file))),
    ]);
    return result.status === 0
      ? []
      : [`${NodePath.relative(root, cwd)}:\n${result.stdout}${result.stderr}`];
  });
  const ok = missing.length === 0 && failed.length === 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${feature.name}`);
  if (missing.length > 0) failures.push(`${feature.name}: missing ${missing.join(", ")}`);
  failures.push(...failed.map((output) => `${feature.name} in ${output}`));
}

if (failures.length > 0) {
  console.error(`\n${failures.join("\n\n")}`);
  process.exit(1);
}
