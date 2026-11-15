import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { managedRuntimeModeCeilingMessage } from "./managedPolicy.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const ProjectPlantAction = Schema.Literals(["plant", "unplant"]);
export type ProjectPlantAction = typeof ProjectPlantAction.Type;

export const ProjectPlantThread = Schema.Struct({
  threadId: ThreadId,
  archived: Schema.optional(Schema.Literal(true)),
});
export type ProjectPlantThread = typeof ProjectPlantThread.Type;

export const ProjectPlantUnavailableReason = Schema.Literals([
  "not_a_repository",
  "no_remote",
  "no_default_branch",
  "read_failed",
]);
export type ProjectPlantUnavailableReason = typeof ProjectPlantUnavailableReason.Type;

export const ProjectPlantStatus = Schema.Union([
  Schema.TaggedStruct("planted", { openThread: Schema.NullOr(ProjectPlantThread) }),
  Schema.TaggedStruct("not_planted", { openThread: Schema.NullOr(ProjectPlantThread) }),
  Schema.TaggedStruct("blocked", { file: Schema.String }),
  Schema.TaggedStruct("unavailable", { reason: ProjectPlantUnavailableReason }),
]);
export type ProjectPlantStatus = typeof ProjectPlantStatus.Type;

export const ProjectPlantReadInput = Schema.Struct({ projectId: ProjectId });
export type ProjectPlantReadInput = typeof ProjectPlantReadInput.Type;

export const ProjectPlantInput = Schema.Struct({
  projectId: ProjectId,
  action: ProjectPlantAction,
});
export type ProjectPlantInput = typeof ProjectPlantInput.Type;

export const ProjectPlantStartResult = Schema.Struct({
  threadId: ThreadId,
  reused: Schema.Boolean,
});
export type ProjectPlantStartResult = typeof ProjectPlantStartResult.Type;

export const ProjectPlantRefusal = Schema.Literals([
  "project_not_found",
  "already_planted",
  "not_planted",
  "blocked",
  "unavailable",
  "no_default_model",
  "launch_failed",
]);
export type ProjectPlantRefusal = typeof ProjectPlantRefusal.Type;

export class ProjectPlantError extends Schema.TaggedError<ProjectPlantError>()(
  "ProjectPlantError",
  {
    projectId: ProjectId,
    reason: ProjectPlantRefusal,
    file: Schema.optional(Schema.String),
    unavailableReason: Schema.optional(ProjectPlantUnavailableReason),
    ceiling: Schema.optional(
      Schema.Struct({ organization: Schema.String, maxRuntimeMode: RuntimeMode }),
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "project_not_found":
        return "The project was not found.";
      case "already_planted":
        return "agent-trust is already set up on the default branch.";
      case "not_planted":
        return "agent-trust is not set up on the default branch.";
      case "blocked":
        return `${this.file ?? "A workflow"} on the default branch is not agent-trust's.`;
      case "unavailable":
        return projectPlantUnavailableMessage(this.unavailableReason ?? "read_failed");
      case "no_default_model":
        return "The project has no default model.";
      case "launch_failed":
        return this.ceiling === undefined
          ? "The thread could not be started."
          : managedRuntimeModeCeilingMessage(
              this.ceiling.organization,
              this.ceiling.maxRuntimeMode,
            );
    }
  }
}

export function projectPlantUnavailableMessage(reason: ProjectPlantUnavailableReason): string {
  switch (reason) {
    case "not_a_repository":
      return "The project folder is not a git repository.";
    case "no_remote":
      return "The repository has no remote.";
    case "no_default_branch":
      return "The remote's default branch is not known here yet.";
    case "read_failed":
      return "The default branch could not be read.";
  }
}
