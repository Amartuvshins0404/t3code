import type { CodemapReadResult } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronRightIcon, RefreshCwIcon, WaypointsIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { visibleView } from "./codemapLayout";

const CodemapCanvas = lazy(() =>
  import("./CodemapCanvas").then((module) => ({ default: module.CodemapCanvas })),
);

type Ready = Extract<CodemapReadResult, { _tag: "ready" }>;

export function CodemapPanel({
  project,
  focusId,
  onFocus,
}: {
  readonly project: EnvironmentProject;
  readonly focusId: string;
  readonly onFocus: (focusId: string) => void;
}) {
  const environmentId = project.environmentId;
  const query = useEnvironmentQuery(
    projectEnvironment.readCodemap({ environmentId, input: { projectId: project.id, focusId } }),
  );
  const analyzeCommand = useAtomCommand(projectEnvironment.analyzeCodemap, {
    reportFailure: false,
  });
  const [analyzing, setAnalyzing] = useState(false);
  const [showMinor, setShowMinor] = useState(false);
  const [shown, setShown] = useState<Ready | null>(null);
  if (query.data?._tag === "ready" && query.data !== shown) setShown(query.data);

  const analyze = async () => {
    setAnalyzing(true);
    const result = await analyzeCommand({ environmentId, input: { projectId: project.id } });
    setAnalyzing(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not map this project",
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    if (focusId === "") query.refresh();
    else onFocus("");
  };

  if (query.data?._tag === "not_analyzed" || (query.error !== null && shown === null)) {
    return (
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyMedia variant="icon">
            <WaypointsIcon />
          </EmptyMedia>
          <EmptyTitle>Map this project</EmptyTitle>
          <EmptyDescription>
            {query.error ??
              "Reads every file and draws how the parts connect. Works with any language."}
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button onClick={analyze} disabled={analyzing}>
              {analyzing ? <Spinner /> : <WaypointsIcon />}
              {analyzing ? "Reading the code…" : "Analyze"}
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    );
  }

  if (query.data?._tag === "unavailable") {
    return (
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>Can't map this folder yet</EmptyTitle>
          <EmptyDescription>
            {query.data.reason === "not_a_repository"
              ? "The map reads the file list from git, and this folder is not a git repository."
              : "The project's files could not be read."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (shown === null) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner size="sm" />
        Reading the code…
      </div>
    );
  }

  const view = visibleView(shown.view, showMinor);
  const totalLanguageFiles = shown.languages.reduce((sum, entry) => sum + entry.files, 0);
  const topLanguages = shown.languages
    .filter((entry) => !["Markdown", "JSON", "YAML", "TOML"].includes(entry.language))
    .filter((entry) => entry.files / Math.max(1, totalLanguageFiles) >= 0.01)
    .slice(0, 3);
  const loadingFocus = query.isPending || shown.view.focusId !== focusId;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2 sm:px-6">
        <nav aria-label="Map location" className="flex min-w-0 items-center gap-1 text-sm">
          {shown.view.path.map((entry, index) => {
            const last = index === shown.view.path.length - 1;
            const label = index === 0 ? project.title : entry.name;
            return (
              <span key={entry.id} className="flex min-w-0 items-center gap-1">
                {index > 0 ? (
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : null}
                {last ? (
                  <span className="truncate font-medium text-foreground">{label}</span>
                ) : (
                  <Button variant="ghost" size="compact" onClick={() => onFocus(entry.id)}>
                    {label}
                  </Button>
                )}
              </span>
            );
          })}
          {loadingFocus ? <Spinner size="xs" tone="muted" className="ms-1" /> : null}
        </nav>
        <div className="ms-auto flex items-center gap-4 text-xs text-muted-foreground">
          <span className="hidden tabular-nums md:inline">
            {shown.totalFiles.toLocaleString()} files
            {topLanguages.map((entry) => (
              <span key={entry.language}>
                {" · "}
                {entry.language} {Math.round((entry.files / Math.max(1, totalLanguageFiles)) * 100)}
                %
              </span>
            ))}
          </span>
          <label className="flex cursor-pointer items-center gap-2">
            <Switch checked={showMinor} onCheckedChange={setShowMinor} />
            Docs and config
          </label>
          <Button variant="ghost" size="compact" onClick={analyze} disabled={analyzing}>
            {analyzing ? <Spinner /> : <RefreshCwIcon />}
            <span>
              Analyzed <RelativeTime timestamp={shown.analyzedAt} />
            </span>
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={null}>
          <CodemapCanvas view={view} onOpen={onFocus} />
        </Suspense>
        {view.nodes.length === 0 ? (
          <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-sm text-muted-foreground">
            Only docs and config here. Turn on “Docs and config” to see them.
          </p>
        ) : null}
      </div>
    </div>
  );
}
