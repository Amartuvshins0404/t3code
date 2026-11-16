import type { CodemapReadResult, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronRightIcon, MapIcon, ZoomInIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useDiffPanelStore } from "~/diffPanelStore";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadCheckpointSummaries } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import {
  filesInside,
  layoutMap,
  type MapBox,
  type PartStatus,
  type TouchedFile,
  touchedFiles,
} from "./codemapTreemap.logic";

type Ready = Extract<CodemapReadResult, { _tag: "ready" }>;

const STATUS_CLASS: Record<"new" | "changed" | "none", { frame: string; fill: string }> = {
  new: {
    frame: "border-success/80 bg-muted/16 text-success-foreground hover:bg-muted/32",
    fill: "border-success bg-success/40 hover:bg-success/52",
  },
  changed: {
    frame: "border-warning/80 bg-muted/16 text-warning-foreground hover:bg-muted/32",
    fill: "border-warning bg-warning/40 hover:bg-warning/52",
  },
  none: {
    frame: "border-border bg-muted/16 hover:bg-muted/32",
    fill: "border-border/50 bg-muted/40 text-muted-foreground hover:bg-muted/64",
  },
};

function formatLines(lines: number): string {
  return lines >= 1000 ? `${(lines / 1000).toFixed(lines >= 10_000 ? 0 : 1)}k` : String(lines);
}

function StatusDot({ status }: { status: PartStatus }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        status === "new" ? "bg-success" : status === "changed" ? "bg-warning" : "bg-muted",
      )}
    />
  );
}

export default function CodemapPanel({
  threadRef,
  projectId,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
}) {
  const [focusId, setFocusId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const query = useEnvironmentQuery(
    projectEnvironment.readCodemap({
      environmentId: threadRef.environmentId,
      input: { projectId, focusId, threadId: threadRef.threadId },
    }),
  );
  const [shown, setShown] = useState<Ready | null>(null);
  if (query.data?._tag === "ready" && query.data !== shown) setShown(query.data);

  const checkpoints = useThreadCheckpointSummaries(threadRef);
  const latestCheckpoint = checkpoints.at(-1)?.checkpointRef ?? null;
  const seenCheckpoint = useRef(latestCheckpoint);
  const { refresh } = query;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a finished turn changes files on disk, so the server map is read again
  useEffect(() => {
    if (seenCheckpoint.current === latestCheckpoint) return;
    seenCheckpoint.current = latestCheckpoint;
    refresh();
  }, [latestCheckpoint, refresh]);

  const measure = (element: HTMLDivElement | null) => {
    if (!element) return;
    return observeResize(element, () => {
      const next = { w: element.clientWidth, h: element.clientHeight };
      setSize((previous) =>
        previous && previous.w === next.w && previous.h === next.h ? previous : next,
      );
    });
  };

  if (query.data?._tag === "unavailable") {
    return (
      <Empty className="flex-1">
        <EmptyHeader className="max-w-sm">
          <EmptyMedia variant="icon">
            <MapIcon />
          </EmptyMedia>
          <EmptyTitle>No code map here</EmptyTitle>
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
        {query.error ?? (
          <>
            <Spinner size="sm" />
            Reading the code…
          </>
        )}
      </div>
    );
  }

  const files = touchedFiles(checkpoints, shown.addedPaths, shown.pathPrefix);
  const boxes = size ? layoutMap(shown.view.nodes, files, size) : [];
  const flat = boxes.flatMap((box) => [box, ...box.children]);
  const selected = flat.find((box) => box.node.id === selectedId) ?? null;
  const listed = filesInside(files, selected?.node.id ?? shown.view.focusId);
  const newCount = files.filter((file) => file.added).length;

  const focus = (id: string) => {
    setSelectedId(null);
    setFocusId(id);
  };
  const openDiff = (file: TouchedFile) => {
    useDiffPanelStore.getState().selectTurn(threadRef, file.runId, file.repoPath);
    useRightPanelStore.getState().open(threadRef, "diff");
  };
  const onBox = (box: MapBox) => {
    if (box.status !== null && box.node.kind === "file") {
      const file = files.find((entry) => entry.path === box.node.id);
      if (file) openDiff(file);
      return;
    }
    if (box.status !== null) setSelectedId(box.node.id === selectedId ? null : box.node.id);
    else if (box.node.kind !== "file" && box.node.childCount > 0) focus(box.node.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-9 items-center gap-2 border-b border-border/65 px-2">
        <nav aria-label="Map location" className="flex min-w-0 flex-1 items-center">
          {shown.view.path.map((entry, index) => (
            <span key={entry.id} className="flex min-w-0 items-center">
              {index > 0 ? (
                <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
              ) : null}
              <Button
                size="xs"
                variant="ghost"
                className="min-w-0"
                disabled={entry.id === shown.view.focusId}
                onClick={() => focus(entry.id)}
              >
                <span className="truncate">{entry.name || "Whole repo"}</span>
              </Button>
            </span>
          ))}
          {query.isPending ? <Spinner size="sm" className="ml-1" /> : null}
        </nav>
        <div className="flex shrink-0 items-center gap-3 text-2xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <StatusDot status="new" />
            New {newCount}
          </span>
          <span className="flex items-center gap-1">
            <StatusDot status="changed" />
            Changed {files.length - newCount}
          </span>
        </div>
      </div>

      <div ref={measure} className="relative min-h-0 flex-1 overflow-hidden">
        {flat.map((box) => {
          const nested = !boxes.includes(box);
          const tone = STATUS_CLASS[box.status ?? "none"];
          const roomy = box.rect.w > 44 && box.rect.h > 15;
          return (
            <button
              key={box.node.id}
              type="button"
              aria-label={`${box.node.id || box.node.name} · ${box.node.lines.toLocaleString()} lines${
                box.touched > 0 ? ` · ${box.touched} touched` : ""
              }`}
              onClick={() => onBox(box)}
              className={cn(
                "absolute flex cursor-pointer items-start overflow-hidden rounded-sm border px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                box.children.length > 0 ? tone.frame : tone.fill,
                box.node.id === selectedId && "ring-2 ring-inset ring-foreground/70",
              )}
              style={{
                left: box.rect.x + 1,
                top: box.rect.y + 1,
                width: Math.max(0, box.rect.w - 2),
                height: Math.max(0, box.rect.h - 2),
              }}
            >
              {roomy ? (
                <span
                  className={cn(
                    "flex min-w-0 items-baseline gap-1 pt-px leading-4",
                    nested ? "text-3xs" : "text-2xs font-medium",
                  )}
                >
                  <span className="truncate">{box.node.name}</span>
                  {!nested && box.rect.w > 110 ? (
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {formatLines(box.node.lines)}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="flex max-h-[38%] min-h-0 flex-col border-t border-border/65">
        <div className="flex min-h-8 items-center gap-2 px-3">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {selected
              ? selected.node.name
              : files.length === 0
                ? "Nothing changed in this thread yet"
                : "Changed in this thread"}
          </span>
          {selected && selected.node.kind !== "file" && selected.node.childCount > 0 ? (
            <Button size="xs" variant="ghost" onClick={() => focus(selected.node.id)}>
              <ZoomInIcon />
              Zoom in
            </Button>
          ) : null}
        </div>
        {listed.length > 0 ? (
          <ScrollArea className="min-h-0 flex-1">
            <ul className="px-1.5 pb-2">
              {listed.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => openDiff(file)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-accent"
                  >
                    <StatusDot status={file.added ? "new" : "changed"} />
                    <span className="min-w-0 flex-1 truncate font-mono text-2xs">{file.path}</span>
                    {file.added ? (
                      <Badge size="sm" variant="success">
                        New
                      </Badge>
                    ) : null}
                    <span className="shrink-0 font-mono text-2xs tabular-nums">
                      <span className="text-success-foreground">+{file.additions}</span>{" "}
                      <span className="text-destructive-foreground">−{file.deletions}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        ) : null}
      </div>
    </div>
  );
}
