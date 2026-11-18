import type {
  CodemapChange,
  CodemapRange,
  CodemapReadResult,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ArrowLeftIcon, ChevronRightIcon, MapIcon } from "lucide-react";
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
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  type ChangeGroup,
  type ChangeItem,
  type GroupBy,
  groupChanges,
  layoutChanges,
  type RiskFlag,
  riskFlags,
  statusShares,
  toItems,
} from "./codemapChanges.logic";
import { layoutMap, type MapBox, touchedFiles } from "./codemapTreemap.logic";

type Ready = Extract<CodemapReadResult, { _tag: "ready" }>;
type Mode = "changes" | "repo";

const STATUS_FILL: Record<CodemapChange["status"], string> = {
  added: "border-success bg-success/36 hover:bg-success/50",
  modified: "border-warning bg-warning/36 hover:bg-warning/50",
  deleted: "border-destructive bg-destructive/28 hover:bg-destructive/42",
  renamed: "border-info bg-info/30 hover:bg-info/44",
};

const STATUS_DOT: Record<CodemapChange["status"], string> = {
  added: "bg-success",
  modified: "bg-warning",
  deleted: "bg-destructive",
  renamed: "bg-info",
};

const STATUS_WORD: Record<CodemapChange["status"], string> = {
  added: "New",
  modified: "Changed",
  deleted: "Deleted",
  renamed: "Moved",
};

const RISK_LABEL: Record<RiskFlag, (count: number) => string> = {
  database: () => "Database change",
  packages: () => "Packages changed",
  deleted: (count) => `${count} deleted`,
  env_or_ci: () => "Env or CI files",
  no_tests: () => "No tests",
};

const REPO_STATUS: Record<"new" | "changed" | "none", { frame: string; fill: string }> = {
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

const STATUS_VAR: Record<CodemapChange["status"], string> = {
  added: "var(--success)",
  modified: "var(--warning)",
  deleted: "var(--destructive)",
  renamed: "var(--info)",
};

function mixBackground(items: ReadonlyArray<ChangeItem>): string {
  let start = 0;
  const stops = statusShares(items).map(({ status, share }) => {
    const color = `color-mix(in srgb, ${STATUS_VAR[status]} 22%, transparent)`;
    const stop = `${color} ${start * 100}% ${(start + share) * 100}%`;
    start += share;
    return stop;
  });
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

function short(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function Delta({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-2xs tabular-nums">
      {additions > 0 ? <span className="text-success-foreground">+{short(additions)}</span> : null}
      {additions > 0 && deletions > 0 ? " " : null}
      {deletions > 0 ? (
        <span className="text-destructive-foreground">−{short(deletions)}</span>
      ) : null}
    </span>
  );
}

function SizeBar({
  additions,
  deletions,
  max,
}: {
  additions: number;
  deletions: number;
  max: number;
}) {
  const scale = max > 0 ? 100 / max : 0;
  return (
    <span className="flex h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
      <span className="bg-success" style={{ width: `${additions * scale}%` }} />
      <span className="bg-destructive" style={{ width: `${deletions * scale}%` }} />
    </span>
  );
}

export default function CodemapPanel({
  threadRef,
  projectId,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
}) {
  const [mode, setMode] = useState<Mode>("changes");
  const [range, setRange] = useState<CodemapRange>("thread");
  const [groupBy, setGroupBy] = useState<GroupBy>("place");
  const [showNoise, setShowNoise] = useState(false);
  const [focusId, setFocusId] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const query = useEnvironmentQuery(
    projectEnvironment.readCodemap({
      environmentId: threadRef.environmentId,
      input: { projectId, focusId, threadId: threadRef.threadId, range },
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

  const items = toItems(shown.changes);
  const noiseCount = items.filter((item) => item.kind === "noise").length;
  const groups = groupChanges(items, groupBy, showNoise);
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;
  const counted = showNoise ? items : items.filter((item) => item.kind !== "noise");
  const additions = counted.reduce((sum, item) => sum + item.additions, 0);
  const deletions = counted.reduce((sum, item) => sum + item.deletions, 0);
  const flags = riskFlags(items);

  const openDiff = (change: CodemapChange) => {
    if (change.runId === null) return;
    useDiffPanelStore
      .getState()
      .selectTurn(threadRef, change.runId, `${shown.pathPrefix}${change.path}`);
    useRightPanelStore.getState().open(threadRef, "diff");
  };
  const pickGroup = (id: string) => setSelectedGroupId(id === selectedGroupId ? null : id);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/65 px-2 py-1.5">
        <ToggleGroup
          aria-label="Map view"
          value={[mode]}
          onValueChange={(next) => {
            if (next[0] === "changes" || next[0] === "repo") setMode(next[0]);
          }}
        >
          <Toggle value="changes">Changes</Toggle>
          <Toggle value="repo">Whole repo</Toggle>
        </ToggleGroup>
        <ToggleGroup
          aria-label="Changes from"
          value={[range]}
          onValueChange={(next) => {
            if (next[0] === "thread" || next[0] === "last_turn") {
              setSelectedGroupId(null);
              setRange(next[0]);
            }
          }}
        >
          <Toggle value="thread">Whole thread</Toggle>
          <Toggle value="last_turn">Last edits</Toggle>
        </ToggleGroup>
        {mode === "changes" ? (
          <ToggleGroup
            aria-label="Group by"
            value={[groupBy]}
            onValueChange={(next) => {
              if (next[0] === "place" || next[0] === "kind") {
                setSelectedGroupId(null);
                setGroupBy(next[0]);
              }
            }}
          >
            <Toggle value="place">By place</Toggle>
            <Toggle value="kind">By kind</Toggle>
          </ToggleGroup>
        ) : null}
        {query.isPending ? <Spinner size="sm" /> : null}
      </div>

      {items.length === 0 && mode === "changes" ? (
        <Empty className="flex-1">
          <EmptyHeader className="max-w-sm">
            <EmptyMedia variant="icon">
              <MapIcon />
            </EmptyMedia>
            <EmptyTitle>No changes yet</EmptyTitle>
            <EmptyDescription>
              Files this thread adds, edits or deletes show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div
            className={cn(
              "flex flex-wrap items-center gap-1.5 px-3 pt-2 pb-1 text-xs",
              items.length === 0 && "hidden",
            )}
          >
            <span className="font-medium">
              {counted.length} {counted.length === 1 ? "file" : "files"}
            </span>
            <Delta additions={additions} deletions={deletions} />
            {flags.map(({ flag, count }) => (
              <Badge
                key={flag}
                size="sm"
                variant={flag === "deleted" || flag === "env_or_ci" ? "error" : "warning"}
              >
                {RISK_LABEL[flag](count)}
              </Badge>
            ))}
            {noiseCount > 0 ? (
              <Button size="xs" variant="ghost" onClick={() => setShowNoise(!showNoise)}>
                {showNoise ? "Hide" : "Show"} {noiseCount} generated
              </Button>
            ) : null}
          </div>

          {mode === "changes" ? (
            <div ref={measure} className="relative mx-2 min-h-0 flex-1 overflow-hidden">
              {size
                ? layoutChanges(groups, size).map((frame) => (
                    <ChangeFrame
                      key={frame.group.id}
                      frame={frame}
                      selected={frame.group.id === selectedGroupId}
                      onGroup={() => pickGroup(frame.group.id)}
                      onFile={openDiff}
                    />
                  ))
                : null}
            </div>
          ) : (
            <RepoMap
              shown={shown}
              size={size}
              measure={measure}
              onFocus={(id) => setFocusId(id)}
              onFile={(path) => {
                const change = shown.changes.find((entry) => entry.path === path);
                if (change) openDiff(change);
              }}
            />
          )}

          <div className="flex max-h-[40%] min-h-0 flex-col border-t border-border/65 mt-2">
            {selectedGroup ? (
              <GroupFiles
                group={selectedGroup}
                onBack={() => setSelectedGroupId(null)}
                onFile={openDiff}
              />
            ) : (
              <GroupList groups={groups} onGroup={pickGroup} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ChangeFrame({
  frame,
  selected,
  onGroup,
  onFile,
}: {
  frame: ReturnType<typeof layoutChanges>[number];
  selected: boolean;
  onGroup: () => void;
  onFile: (change: CodemapChange) => void;
}) {
  const { group, rect } = frame;
  return (
    <>
      <button
        type="button"
        aria-label={`${group.name}: ${group.summary}`}
        onClick={onGroup}
        className={cn(
          "absolute flex cursor-pointer items-start overflow-hidden rounded-sm border border-border bg-muted/12 px-1 text-left outline-none hover:bg-muted/28 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          selected && "ring-2 ring-inset ring-foreground/70",
        )}
        style={{
          left: rect.x + 1,
          top: rect.y + 1,
          width: Math.max(0, rect.w - 2),
          height: Math.max(0, rect.h - 2),
        }}
      >
        <span className="flex min-w-0 items-baseline gap-1 pt-px text-2xs leading-4 font-medium">
          <span className="truncate">{group.name}</span>
          {rect.w > 120 ? <Delta additions={group.additions} deletions={group.deletions} /> : null}
        </span>
      </button>
      {frame.tiles.map((tile) => {
        const roomy = tile.rect.w > 40 && tile.rect.h > 16;
        const tall = tile.rect.h > 32;
        const label =
          tile.item === null
            ? `${tile.rest.length} more`
            : `${baseName(tile.item.path)}${tile.item.from ? ` ← ${baseName(tile.item.from)}` : ""}`;
        return (
          <button
            key={tile.key}
            type="button"
            aria-label={
              tile.item === null
                ? `${tile.rest.length} smaller files in ${group.name}`
                : `${tile.item.path} · ${STATUS_WORD[tile.item.status]} · +${tile.item.additions} −${tile.item.deletions}`
            }
            onClick={() => (tile.item === null ? onGroup() : onFile(tile.item))}
            className={cn(
              "absolute flex cursor-pointer flex-col items-start overflow-hidden rounded-sm border px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              tile.item === null
                ? "border-border hover:brightness-125"
                : STATUS_FILL[tile.item.status],
            )}
            style={{
              left: tile.rect.x + 1,
              top: tile.rect.y + 1,
              width: Math.max(0, tile.rect.w - 2),
              height: Math.max(0, tile.rect.h - 2),
              ...(tile.item === null ? { background: mixBackground(tile.rest) } : {}),
            }}
          >
            {roomy ? (
              <span className="w-full truncate pt-px text-2xs leading-4">{label}</span>
            ) : null}
            {roomy && tall ? (
              tile.item === null ? (
                <Delta
                  additions={tile.rest.reduce((sum, item) => sum + item.additions, 0)}
                  deletions={tile.rest.reduce((sum, item) => sum + item.deletions, 0)}
                />
              ) : (
                <Delta additions={tile.item.additions} deletions={tile.item.deletions} />
              )
            ) : null}
          </button>
        );
      })}
    </>
  );
}

function GroupList({
  groups,
  onGroup,
}: {
  groups: ReadonlyArray<ChangeGroup>;
  onGroup: (id: string) => void;
}) {
  const max = Math.max(0, ...groups.map((group) => group.additions + group.deletions));
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul className="px-1.5 py-1.5">
        {groups.map((group) => (
          <li key={group.id}>
            <button
              type="button"
              onClick={() => onGroup(group.id)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-accent"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs font-medium">{group.name}</span>
                <span className="truncate text-2xs text-muted-foreground">{group.summary}</span>
              </span>
              <SizeBar additions={group.additions} deletions={group.deletions} max={max} />
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

function GroupFiles({
  group,
  onBack,
  onFile,
}: {
  group: ChangeGroup;
  onBack: () => void;
  onFile: (change: ChangeItem) => void;
}) {
  return (
    <>
      <div className="flex min-h-8 items-center gap-1 px-1.5">
        <Button size="xs" variant="ghost" onClick={onBack} aria-label="All groups">
          <ArrowLeftIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{group.name}</span>
        <span className="truncate text-2xs text-muted-foreground">{group.summary}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="px-1.5 pb-2">
          {group.items.map((item) => (
            <li key={item.path}>
              <button
                type="button"
                disabled={item.runId === null}
                onClick={() => onFile(item)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-accent disabled:cursor-default"
              >
                <span
                  aria-hidden
                  className={cn(
                    "inline-block size-2 shrink-0 rounded-full",
                    STATUS_DOT[item.status],
                  )}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-2xs">
                  {item.from ? `${item.from} → ${item.path}` : item.path}
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {STATUS_WORD[item.status]}
                </span>
                <Delta additions={item.additions} deletions={item.deletions} />
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </>
  );
}

function RepoMap({
  shown,
  size,
  measure,
  onFocus,
  onFile,
}: {
  shown: Ready;
  size: { w: number; h: number } | null;
  measure: (element: HTMLDivElement | null) => (() => void) | undefined;
  onFocus: (id: string) => void;
  onFile: (path: string) => void;
}) {
  const files = touchedFiles(shown.changes);
  const boxes = size ? layoutMap(shown.view.nodes, files, size) : [];
  const flat = boxes.flatMap((box) => [box, ...box.children]);
  const onBox = (box: MapBox) => {
    if (box.status !== null && box.node.kind === "file") onFile(box.node.id);
    else if (box.node.kind !== "file" && box.node.childCount > 0) onFocus(box.node.id);
  };
  return (
    <>
      <nav aria-label="Map location" className="flex min-w-0 items-center px-2">
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
              onClick={() => onFocus(entry.id)}
            >
              <span className="truncate">{entry.name || "Whole repo"}</span>
            </Button>
          </span>
        ))}
      </nav>
      <div ref={measure} className="relative mx-2 min-h-0 flex-1 overflow-hidden">
        {flat.map((box) => {
          const nested = !boxes.includes(box);
          const tone = REPO_STATUS[box.status ?? "none"];
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
                      {short(box.node.lines)}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </>
  );
}
