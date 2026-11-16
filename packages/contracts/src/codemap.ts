import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const CodemapNodeKind = Schema.Literals(["root", "package", "folder", "file"]);
export type CodemapNodeKind = typeof CodemapNodeKind.Type;

export const CodemapViewNode = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  kind: CodemapNodeKind,
  name: Schema.String,
  language: Schema.NullOr(Schema.String),
  files: Schema.Number,
  lines: Schema.Number,
  childCount: Schema.Number,
  vendored: Schema.Boolean,
  minor: Schema.Boolean,
});
export type CodemapViewNode = typeof CodemapViewNode.Type;

export const CodemapView = Schema.Struct({
  focusId: Schema.String,
  path: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  nodes: Schema.Array(CodemapViewNode),
  hiddenChildren: Schema.Number,
});
export type CodemapView = typeof CodemapView.Type;

export const CodemapUnavailableReason = Schema.Literals(["not_a_repository", "read_failed"]);
export type CodemapUnavailableReason = typeof CodemapUnavailableReason.Type;

export const CodemapReadResult = Schema.Union([
  Schema.TaggedStruct("unavailable", { reason: CodemapUnavailableReason }),
  Schema.TaggedStruct("ready", {
    view: CodemapView,
    addedPaths: Schema.Array(Schema.String),
    pathPrefix: Schema.String,
    totalFiles: Schema.Number,
    analyzedAt: Schema.String,
  }),
]);
export type CodemapReadResult = typeof CodemapReadResult.Type;

export const CodemapReadInput = Schema.Struct({
  projectId: ProjectId,
  focusId: Schema.String,
  threadId: Schema.optionalKey(ThreadId),
});
export type CodemapReadInput = typeof CodemapReadInput.Type;

export class CodemapError extends Schema.TaggedError<CodemapError>()("CodemapError", {
  projectId: ProjectId,
  reason: Schema.Literals(["project_not_found"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return "The project was not found.";
  }
}
