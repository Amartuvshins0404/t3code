import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";

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
  external: Schema.Boolean,
});
export type CodemapViewNode = typeof CodemapViewNode.Type;

export const CodemapViewEdge = Schema.Struct({
  source: Schema.String,
  target: Schema.String,
  weight: Schema.Number,
});
export type CodemapViewEdge = typeof CodemapViewEdge.Type;

export const CodemapView = Schema.Struct({
  focusId: Schema.String,
  path: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  nodes: Schema.Array(CodemapViewNode),
  edges: Schema.Array(CodemapViewEdge),
  hiddenChildren: Schema.Number,
});
export type CodemapView = typeof CodemapView.Type;

export const CodemapLanguageCount = Schema.Struct({
  language: Schema.String,
  files: Schema.Number,
});

export const CodemapUnavailableReason = Schema.Literals(["not_a_repository", "read_failed"]);
export type CodemapUnavailableReason = typeof CodemapUnavailableReason.Type;

export const CodemapReadResult = Schema.Union([
  Schema.TaggedStruct("not_analyzed", {}),
  Schema.TaggedStruct("unavailable", { reason: CodemapUnavailableReason }),
  Schema.TaggedStruct("ready", {
    view: CodemapView,
    languages: Schema.Array(CodemapLanguageCount),
    totalFiles: Schema.Number,
    analyzedAt: Schema.String,
    durationMs: Schema.Number,
  }),
]);
export type CodemapReadResult = typeof CodemapReadResult.Type;

export const CodemapReadInput = Schema.Struct({
  projectId: ProjectId,
  focusId: Schema.String,
});
export type CodemapReadInput = typeof CodemapReadInput.Type;

export const CodemapAnalyzeInput = Schema.Struct({ projectId: ProjectId });
export type CodemapAnalyzeInput = typeof CodemapAnalyzeInput.Type;

export class CodemapError extends Schema.TaggedError<CodemapError>()("CodemapError", {
  projectId: ProjectId,
  reason: Schema.Literals(["project_not_found", "store_failed"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason === "project_not_found"
      ? "The project was not found."
      : "The code map could not be saved.";
  }
}
