import {
  CommandId,
  MessageId,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type ProjectId,
  ProjectPlantError,
  type ProjectPlantAction,
  type ProjectPlantStartResult,
  type ProjectPlantStatus,
  type ProjectPlantUnavailableReason,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { runtimeModeRank } from "../mcp/delegatedTaskModes.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "./ProjectService.ts";

const MERGE_LANE_PATH = ".github/workflows/merge-lane.yml";
const BLIND_CHECKS_PATH = ".github/workflows/blind-checks.yml";
const MERGE_LANE_CALL = "Amartuvshins0404/agent-trust/.github/workflows/merge-lane.yml@";
const BLIND_CHECKS_CALL = "Amartuvshins0404/agent-trust/.github/workflows/blind-checks.yml@";
const MAX_PLANT_ATTEMPTS = 20;
const isAboveCeilingError = Schema.is(OrchestratorRuntimeModeAboveCeilingError);

export const threadTitle = (action: ProjectPlantAction) =>
  action === "plant" ? "Plant agent-trust" : "Unplant agent-trust";

const PLANT_FIRST_MESSAGE = `Set up agent-trust in this repository and open one pull request for it. You are in a new checkout of the default branch, on a new branch made for this work.

1. Run \`gh pr list --state open --search "agent-trust in:title"\`. If an open pull request already adds agent-trust, reply with its link and stop.
2. From the repository root, run \`npx -y github:Amartuvshins0404/agent-trust#v0 setup\`. Read what it prints. If it stops because a workflow is not agent-trust's, reply with what it printed and stop. Do not rename, edit or delete that workflow. If it wrote nothing because everything is already there, reply that agent-trust is already set up and stop.
3. Stage only the files the command printed after "Wrote". Commit them with the message \`ci: add agent-trust merge lanes and blind checks\`.
4. Push the branch. Open one pull request into the default branch, titled \`ci: add agent-trust merge lanes and blind checks\`, with the body \`Adds the agent-trust caller workflows. They only report.\`
5. Reply with the pull request link and stop.

Never set the repository variables BLIND_CHECKS_MODE or TEST_STRENGTH_MODE. Never run \`setup --protect\`. Never merge the pull request. Change no other file.`;

const UNPLANT_FIRST_MESSAGE = `Remove agent-trust from this repository and open one pull request for it. You are in a new checkout of the default branch, on a new branch made for this work.

1. Run \`gh pr list --state open --search "agent-trust in:title"\`. If an open pull request already removes agent-trust, reply with its link and stop.
2. Make an empty first commit: \`git commit --allow-empty -m "chore: no checks needed" -m "Blind-checks: none, removes CI workflow files only"\`.
3. From the repository root, run \`npx -y github:Amartuvshins0404/agent-trust#v0 setup --remove\`. Read what it prints.
4. Stage only the deletions the command printed after "Deleted". Commit them with the message \`ci: remove agent-trust merge lanes and blind checks\`.
5. Push the branch. Open one pull request into the default branch, titled \`ci: remove agent-trust merge lanes and blind checks\`, with this body:

   ## Request
   Remove agent-trust's caller workflows and settings file from this repository.

6. Reply with the pull request link and stop.

Never set the repository variables BLIND_CHECKS_MODE or TEST_STRENGTH_MODE. Never run \`setup --protect\`. Never merge the pull request. Change no other file.`;

interface DefaultBranch {
  readonly remoteName: string;
  readonly branchName: string;
  readonly commit: string;
}

type DefaultBranchReading =
  | { readonly _tag: "unavailable"; readonly reason: ProjectPlantUnavailableReason }
  | { readonly _tag: "blocked"; readonly file: string }
  | { readonly _tag: "planted" | "not_planted"; readonly base: DefaultBranch };

const unavailable = (reason: ProjectPlantUnavailableReason): DefaultBranchReading => ({
  _tag: "unavailable",
  reason,
});

export class ProjectPlant extends Context.Service<
  ProjectPlant,
  {
    readonly readStatus: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<ProjectPlantStatus, ProjectPlantError>;
    readonly start: (input: {
      readonly projectId: ProjectId;
      readonly action: ProjectPlantAction;
      readonly createdBy: OrchestrationV2Actor;
      readonly creationSource: OrchestrationV2CreationSource;
      readonly runtimeMode?: RuntimeMode;
      readonly interactionMode?: ProviderInteractionMode;
    }) => Effect.Effect<ProjectPlantStartResult, ProjectPlantError>;
  }
>()("t3/project/ProjectPlant") {}

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectService.ProjectService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const digest = yield* Digest.Digest;

  const loadProject = Effect.fn("ProjectPlant.loadProject")(function* (projectId: ProjectId) {
    const project = yield* projects
      .getById(projectId)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectPlantError({ projectId, reason: "project_not_found", cause }),
        ),
      );
    if (Option.isNone(project))
      return yield* new ProjectPlantError({ projectId, reason: "project_not_found" });
    return project.value;
  });

  const readDefaultBranch = Effect.fn("ProjectPlant.readDefaultBranch")(
    function* (cwd: string) {
      const run = (operation: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
        git.execute({ operation: `ProjectPlant.${operation}`, cwd, args, allowNonZeroExit });
      const gitDir = yield* run("gitDir", ["rev-parse", "--git-dir"], true);
      if (gitDir.exitCode !== 0) return unavailable("not_a_repository");
      const remotes = (yield* run("remotes", ["remote"])).stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const remoteName = remotes.includes("origin") ? "origin" : remotes[0];
      if (remoteName === undefined) return unavailable("no_remote");
      yield* git.refreshRemoteIfStale({ cwd, remoteName }).pipe(Effect.ignore);
      const branchName = yield* git.resolveDefaultBranchName(cwd, remoteName);
      if (branchName === null) return unavailable("no_default_branch");
      const resolved = yield* run(
        "commit",
        ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteName}/${branchName}^{commit}`],
        true,
      );
      if (resolved.exitCode !== 0) return unavailable("no_default_branch");
      const commit = resolved.stdout.trim();
      const present = new Set(
        (yield* run("listWorkflows", [
          "ls-tree",
          "--full-tree",
          "--name-only",
          "-z",
          commit,
          "--",
          MERGE_LANE_PATH,
          BLIND_CHECKS_PATH,
        ])).stdout.split("\0"),
      );
      const readWorkflow = (file: string) =>
        run("readWorkflow", ["show", `${commit}:${file}`]).pipe(
          Effect.map((result) => result.stdout),
        );
      const base = { remoteName, branchName, commit };
      if (present.has(MERGE_LANE_PATH)) {
        return (yield* readWorkflow(MERGE_LANE_PATH)).includes(MERGE_LANE_CALL)
          ? ({ _tag: "planted", base } as const)
          : ({ _tag: "blocked", file: MERGE_LANE_PATH } as const);
      }
      if (
        present.has(BLIND_CHECKS_PATH) &&
        !(yield* readWorkflow(BLIND_CHECKS_PATH)).includes(BLIND_CHECKS_CALL)
      )
        return { _tag: "blocked", file: BLIND_CHECKS_PATH } as const;
      return { _tag: "not_planted", base } as const;
    },
    Effect.catchTags({
      GitCommandError: () => Effect.succeed(unavailable("read_failed")),
    }),
  );

  const plantCommandId = Effect.fn("ProjectPlant.commandId")(function* (
    action: ProjectPlantAction,
    projectId: ProjectId,
    commit: string,
    attempt: number,
  ) {
    const parts =
      attempt === 0 ? [action, projectId, commit] : [action, projectId, commit, attempt];
    // @effect-diagnostics-next-line globalJsonInEffect:off - a JSON tuple keeps the parts apart.
    const bytes = new TextEncoder().encode(JSON.stringify(parts));
    const hash = yield* digest.digest(Digest.sha256, bytes).pipe(Effect.orDie);
    return CommandId.make(`project-plant:${Hex.encode(hash)}`);
  });

  const findPlantSlot = Effect.fn("ProjectPlant.findSlot")(function* (
    action: ProjectPlantAction,
    projectId: ProjectId,
    commit: string,
  ) {
    for (let attempt = 0; attempt < MAX_PLANT_ATTEMPTS; attempt++) {
      const commandId = yield* plantCommandId(action, projectId, commit, attempt);
      const threadId = ThreadId.make(commandId);
      const used = yield* threads.hasReceipt(commandId);
      const shell = yield* threads.getThreadShell(threadId);
      if (shell !== null && shell.deletedAt === null) return { _tag: "open", threadId } as const;
      if (!used) return { _tag: "free", commandId } as const;
    }
    return { _tag: "exhausted" } as const;
  });

  const readStatus: ProjectPlant["Service"]["readStatus"] = Effect.fn("ProjectPlant.readStatus")(
    function* ({ projectId }) {
      const project = yield* loadProject(projectId);
      const reading = yield* readDefaultBranch(project.workspaceRoot);
      if (reading._tag === "unavailable" || reading._tag === "blocked") return reading;
      const action = reading._tag === "planted" ? "unplant" : "plant";
      const slot = yield* findPlantSlot(action, projectId, reading.base.commit).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Plant status: the plant thread lookup failed", {
            projectId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (slot === null) return { _tag: "unavailable", reason: "read_failed" } as const;
      return {
        _tag: reading._tag,
        openThread: slot._tag === "open" ? { threadId: slot.threadId } : null,
      };
    },
  );

  const start: ProjectPlant["Service"]["start"] = Effect.fn("ProjectPlant.start")(
    function* (input) {
      const { projectId, action } = input;
      const refuse = (
        reason: ProjectPlantError["reason"],
        details: Partial<
          Pick<ProjectPlantError, "file" | "unavailableReason" | "ceiling" | "cause">
        > = {},
      ) => new ProjectPlantError({ projectId, reason, ...details });
      const project = yield* loadProject(projectId);
      const reading = yield* readDefaultBranch(project.workspaceRoot);
      if (reading._tag === "unavailable")
        return yield* refuse("unavailable", { unavailableReason: reading.reason });
      if (reading._tag === "blocked") return yield* refuse("blocked", { file: reading.file });
      if (action === "plant" && reading._tag === "planted") return yield* refuse("already_planted");
      if (action === "unplant" && reading._tag === "not_planted")
        return yield* refuse("not_planted");

      const slot = yield* findPlantSlot(action, projectId, reading.base.commit).pipe(
        Effect.mapError((cause) =>
          refuse("unavailable", { unavailableReason: "read_failed", cause }),
        ),
      );
      if (slot._tag === "open") return { threadId: slot.threadId, reused: true };
      if (slot._tag === "exhausted") return yield* refuse("launch_failed");
      const { commandId } = slot;

      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) => refuse("launch_failed", { cause })),
      );
      const defaults = resolveProjectSettings(settings, projectId, project).settings;
      const modelSelection =
        resolveNewThreadModelSelection({
          defaultSelection: defaults.defaultModelSelection,
          fallbackSelection: defaults.fallbackModelSelection,
          providers: yield* providerRegistry.getProviders,
          settings: defaults,
          projectId,
          now: DateTime.toEpochMillis(yield* DateTime.now),
        }).selection ?? defaults.fallbackModelSelection;
      if (modelSelection === null) return yield* refuse("no_default_model");
      const runtimeMode =
        input.runtimeMode !== undefined &&
        runtimeModeRank(input.runtimeMode) < runtimeModeRank(defaults.defaultRuntimeMode)
          ? input.runtimeMode
          : defaults.defaultRuntimeMode;
      const workspaceStrategy = {
        type: "worktree",
        baseRef: `${reading.base.remoteName}/${reading.base.branchName}`,
        startFromOrigin: true,
      } as const;
      yield* launches
        .checkWorktreeBase({ projectId, workspaceStrategy, commandId })
        .pipe(Effect.mapError((cause) => refuse("launch_failed", { cause })));
      const launched = yield* launches
        .launch({
          commandId,
          threadId: ThreadId.make(commandId),
          projectId,
          title: threadTitle(action),
          modelSelection,
          runtimeMode,
          interactionMode: input.interactionMode ?? "default",
          workspaceStrategy,
          initialMessage: {
            messageId: MessageId.make(commandId),
            text: action === "plant" ? PLANT_FIRST_MESSAGE : UNPLANT_FIRST_MESSAGE,
            attachments: [],
          },
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        })
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "ThreadLaunchError" && isAboveCeilingError(cause.cause)
              ? refuse("launch_failed", {
                  cause,
                  ceiling: {
                    organization: cause.cause.organization,
                    maxRuntimeMode: cause.cause.maxRuntimeMode,
                  },
                })
              : refuse("launch_failed", { cause }),
          ),
        );
      return { threadId: launched.threadId, reused: false };
    },
  );

  return ProjectPlant.of({ readStatus, start });
});

export const layer = Layer.effect(ProjectPlant, make);
