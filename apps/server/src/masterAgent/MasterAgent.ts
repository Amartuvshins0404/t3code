import {
  CommandId,
  isProviderAvailable,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as MasterAgentStore from "../persistence/MasterAgentStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const MASTER_AGENT_THREAD_TITLE = "Agent";
export const MASTER_AGENT_MEMORY_MAX_BYTES = 32_768;
const MASTER_AGENT_MEMORY_KEY_MAX_LENGTH = 80;

export class MasterAgentEnsureError extends Schema.TaggedError<MasterAgentEnsureError>()(
  "MasterAgentEnsureError",
  {
    stage: Schema.Literals(["scratch-project", "thread-id", "read-thread", "model", "launch"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "scratch-project":
        return "Could not open the No project folder for the agent.";
      case "model":
        return "No provider is ready to run the agent. Set up a provider, then try again.";
      default:
        return "Could not open the agent thread.";
    }
  }
}

export class MasterAgentMemoryKeyError extends Schema.TaggedError<MasterAgentMemoryKeyError>()(
  "MasterAgentMemoryKeyError",
  { length: Schema.Number },
) {
  override get message(): string {
    return `A memory key needs 1 to ${MASTER_AGENT_MEMORY_KEY_MAX_LENGTH} characters.`;
  }
}

export class MasterAgentMemoryFullError extends Schema.TaggedError<MasterAgentMemoryFullError>()(
  "MasterAgentMemoryFullError",
  { usedBytes: Schema.Number, requestedBytes: Schema.Number, limitBytes: Schema.Number },
) {
  override get message(): string {
    return `Memory is full: this write needs ${this.requestedBytes} bytes, and ${this.usedBytes} of ${this.limitBytes} are used by other keys. Shorten or delete keys with agent_memory_write (empty content deletes), then retry.`;
  }
}

export type MasterAgentMemoryWriteError =
  | MasterAgentMemoryKeyError
  | MasterAgentMemoryFullError
  | MasterAgentStore.MasterAgentStoreError;

export interface MasterAgentMemoryWriteResult {
  readonly key: string;
  readonly deleted: boolean;
  readonly usedBytes: number;
  readonly limitBytes: number;
}

export class MasterAgent extends Context.Service<
  MasterAgent,
  {
    /** Opens the one master thread, creating it the first time or when its thread is gone. */
    readonly ensure: Effect.Effect<
      { readonly projectId: ProjectId; readonly threadId: ThreadId },
      MasterAgentEnsureError
    >;
    /** The master thread's id, reserved before the thread exists so clients can hide it from the start. */
    readonly threadId: Effect.Effect<ThreadId, MasterAgentEnsureError>;
    readonly listMemory: MasterAgentStore.MasterAgentStore["Service"]["listMemory"];
    /** Empty content deletes the key. */
    readonly writeMemory: (input: {
      readonly key: string;
      readonly content: string;
    }) => Effect.Effect<MasterAgentMemoryWriteResult, MasterAgentMemoryWriteError>;
  }
>()("t3/masterAgent/MasterAgent") {}

function firstReadySelection(providers: ReadonlyArray<ServerProvider>): ModelSelection | null {
  for (const provider of providers) {
    if (!provider.enabled || !provider.installed || !isProviderAvailable(provider)) continue;
    const model = provider.models.find((candidate) => candidate.isDefault) ?? provider.models[0];
    if (model !== undefined) return { instanceId: provider.instanceId, model: model.slug };
  }
  return null;
}

const make = Effect.gen(function* () {
  const store = yield* MasterAgentStore.MasterAgentStore;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const random = yield* SecureRandom.SecureRandom;
  const ensureLock = yield* Semaphore.make(1);

  const fail = (stage: MasterAgentEnsureError["stage"]) => (cause: unknown) =>
    new MasterAgentEnsureError({ stage, cause });

  const newThreadId = random.uuidV4().pipe(
    Effect.map((id) => ThreadId.make(id)),
    Effect.mapError(fail("thread-id")),
  );

  const resolveSelection = Effect.fn("MasterAgent.resolveSelection")(function* (
    projectId: ProjectId,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.mapError(fail("model")));
    const project = Option.getOrNull(
      yield* projects.getById(projectId).pipe(Effect.mapError(fail("model"))),
    );
    const effective = resolveProjectSettings(settings, projectId, project).settings;
    const providers = yield* providerRegistry.getProviders;
    const selection =
      resolveNewThreadModelSelection({
        defaultSelection: effective.defaultModelSelection,
        fallbackSelection: effective.fallbackModelSelection,
        providers,
        settings,
        projectId,
        now: DateTime.toEpochMillis(yield* DateTime.now),
      }).selection ?? firstReadySelection(providers);
    if (selection === null) return yield* new MasterAgentEnsureError({ stage: "model" });
    return { selection, runtimeMode: effective.defaultRuntimeMode };
  });

  const reservedThreadId = Effect.gen(function* () {
    const stored = yield* store.readThreadId.pipe(Effect.mapError(fail("thread-id")));
    if (stored !== null) return stored;
    return yield* store.claimThreadId(yield* newThreadId).pipe(Effect.mapError(fail("thread-id")));
  });

  // A fixed command id applies the opt-out once; a user who turns auto-settle back on keeps it.
  const keepUnsettled = (threadId: ThreadId) =>
    threads
      .dispatch({
        type: "thread.auto-settle.set",
        commandId: CommandId.make(`master-agent-auto-settle:${threadId}`),
        threadId,
        enabled: false,
      })
      .pipe(Effect.mapError(fail("launch")));

  const ensure: MasterAgent["Service"]["ensure"] = Effect.gen(function* () {
    const { projectId } = yield* managedFolders.ensureScratchProject.pipe(
      Effect.mapError(fail("scratch-project")),
    );
    let threadId = yield* reservedThreadId;
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(fail("read-thread")));
    if (shell !== null && shell.deletedAt === null) {
      if (shell.autoSettleDisabledAt == null) yield* keepUnsettled(threadId);
      return { projectId: shell.projectId, threadId };
    }
    if (shell !== null) {
      threadId = yield* store
        .replaceThreadId({ previous: threadId, next: yield* newThreadId })
        .pipe(Effect.mapError(fail("thread-id")));
    }
    const { selection, runtimeMode } = yield* resolveSelection(projectId);
    const launched = yield* launches
      .launch({
        commandId: CommandId.make(`master-agent:${threadId}`),
        threadId,
        projectId,
        title: MASTER_AGENT_THREAD_TITLE,
        modelSelection: selection,
        runtimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.mapError(fail("launch")));
    yield* keepUnsettled(launched.threadId);
    return { projectId: launched.projection.thread.projectId, threadId: launched.threadId };
  }).pipe(ensureLock.withPermits(1), Effect.withSpan("MasterAgent.ensure"));

  const writeMemory: MasterAgent["Service"]["writeMemory"] = Effect.fn("MasterAgent.writeMemory")(
    function* (input) {
      const key = input.key.trim();
      if (key.length === 0 || key.length > MASTER_AGENT_MEMORY_KEY_MAX_LENGTH)
        return yield* new MasterAgentMemoryKeyError({ length: key.length });
      const content = input.content.trim();
      const deleted = content.length === 0;
      const result = yield* store.writeMemory({
        key,
        content: deleted ? null : content,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
        limitBytes: MASTER_AGENT_MEMORY_MAX_BYTES,
      });
      if (!result.written)
        return yield* new MasterAgentMemoryFullError({
          usedBytes: result.otherBytes,
          requestedBytes: result.requestedBytes,
          limitBytes: MASTER_AGENT_MEMORY_MAX_BYTES,
        });
      return {
        key,
        deleted,
        usedBytes: result.otherBytes + result.requestedBytes,
        limitBytes: MASTER_AGENT_MEMORY_MAX_BYTES,
      };
    },
  );

  return MasterAgent.of({
    ensure,
    threadId: reservedThreadId,
    listMemory: store.listMemory,
    writeMemory,
  });
});

export const layer = Layer.effect(MasterAgent, make);
