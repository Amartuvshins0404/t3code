import "@xyflow/react/dist/base.css";

import type { CodemapView, CodemapViewNode } from "@t3tools/contracts";
import {
  Background,
  BackgroundVariant,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { ChevronRightIcon, FileIcon, FolderIcon, PackageIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { type CodemapLayout, formatCount, languageColor, layoutCodemap } from "./codemapLayout";

type CodemapNodeData = {
  readonly item: CodemapViewNode;
  readonly hiddenChildren: number;
  readonly dimmed: boolean;
  readonly active: boolean;
};

type CodemapFlowNode = Node<CodemapNodeData>;

const HANDLE_CLASS = "!pointer-events-none !size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent";

function Handles() {
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className={HANDLE_CLASS}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className={HANDLE_CLASS}
      />
    </>
  );
}

function KindIcon({ item, className }: { item: CodemapViewNode; className?: string }) {
  const Icon = item.kind === "package" ? PackageIcon : item.kind === "file" ? FileIcon : FolderIcon;
  return <Icon className={cn("size-3.5 shrink-0", className)} />;
}

function opensInto(item: CodemapViewNode) {
  return item.kind !== "file" && item.childCount > 0;
}

const GroupNode = memo(function GroupNode({ data }: NodeProps<CodemapFlowNode>) {
  const { item, hiddenChildren, dimmed, active } = data;
  return (
    <div
      className={cn(
        "group/codemap size-full cursor-pointer rounded-xl border bg-card/80 transition-[opacity,border-color] duration-150",
        active ? "border-foreground/40" : "border-border",
        dimmed && "opacity-35",
      )}
    >
      <Handles />
      <div className="flex h-11 items-center gap-2 px-3">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: languageColor(item.language) }}
        />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{item.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatCount(item.files)} files
          {hiddenChildren > 0 ? ` · +${hiddenChildren} more` : ""}
        </span>
        <ChevronRightIcon className="ms-auto size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/codemap:opacity-100" />
      </div>
    </div>
  );
});

const LeafNode = memo(function LeafNode({ data }: NodeProps<CodemapFlowNode>) {
  const { item, dimmed, active } = data;
  const openable = opensInto(item);
  return (
    <div
      className={cn(
        "flex size-full flex-col justify-center gap-0.5 rounded-xl border px-3 transition-[opacity,border-color] duration-150",
        item.external ? "border-dashed bg-transparent" : "bg-card",
        active ? "border-foreground/40" : "border-border",
        openable && "cursor-pointer",
        dimmed && "opacity-35",
      )}
    >
      <Handles />
      <div className="flex min-w-0 items-center gap-2">
        <KindIcon item={item} className="text-muted-foreground" />
        <span
          className={cn(
            "min-w-0 truncate text-sm font-medium",
            item.external ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {item.name}
        </span>
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {item.kind === "file"
          ? `${formatCount(item.lines)} lines`
          : `${formatCount(item.files)} files · ${formatCount(item.lines)} lines`}
      </span>
    </div>
  );
});

const ChipNode = memo(function ChipNode({ data }: NodeProps<CodemapFlowNode>) {
  const { item, dimmed, active } = data;
  const openable = opensInto(item);
  return (
    <div
      className={cn(
        "flex size-full items-center gap-1.5 rounded-md border bg-background px-2 text-xs transition-[opacity,border-color,background-color] duration-150",
        active ? "border-foreground/40 bg-accent" : "border-border/70",
        openable ? "cursor-pointer hover:bg-accent" : "cursor-default",
        dimmed && "opacity-35",
      )}
    >
      <Handles />
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: languageColor(item.language) }}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">{item.name}</span>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {formatCount(item.kind === "file" ? item.lines : item.files)}
      </span>
    </div>
  );
});

const nodeTypes = { group: GroupNode, leaf: LeafNode, chip: ChipNode };

function edgeWidth(weight: number) {
  return Math.min(4, 1 + Math.log2(weight) / 3);
}

function buildFlow(layout: CodemapLayout, hovered: string | null) {
  const parentOf = new Map(layout.nodes.map((entry) => [entry.node.id, entry.node.parentId]));
  const hoveredIsChip = hovered !== null && parentOf.get(hovered) != null;
  const shownEdges = hoveredIsChip
    ? layout.edges.filter((edge) => edge.source === hovered || edge.target === hovered)
    : layout.groupEdges;
  const related = new Set<string>();
  if (hovered !== null) {
    related.add(hovered);
    for (const edge of shownEdges) {
      if (edge.source !== hovered && edge.target !== hovered) continue;
      for (const id of [edge.source, edge.target]) {
        related.add(id);
        const parent = parentOf.get(id);
        if (parent) related.add(parent);
      }
    }
  }
  const isRelated = (id: string) => {
    if (related.has(id)) return true;
    const parent = parentOf.get(id);
    return parent != null && (parent === hovered || (!hoveredIsChip && related.has(parent)));
  };

  const groups = new Set(layout.nodes.map((entry) => entry.node.parentId));
  const nodes: CodemapFlowNode[] = layout.nodes.map((entry) => {
    const { node } = entry;
    const isGroup = node.parentId === null && groups.has(node.id);
    return {
      id: node.id,
      type: node.parentId !== null ? "chip" : isGroup ? "group" : "leaf",
      position: { x: entry.x, y: entry.y },
      width: entry.width,
      height: entry.height,
      ...(node.parentId !== null ? { parentId: node.parentId } : {}),
      draggable: false,
      selectable: false,
      data: {
        item: node,
        hiddenChildren: entry.hiddenChildren,
        dimmed: hovered !== null && !isRelated(node.id),
        active: hovered === node.id,
      },
    };
  });

  const edges: Edge[] = shownEdges.map((edge) => {
    const lit = hovered !== null && (edge.source === hovered || edge.target === hovered);
    const color = lit ? "var(--foreground)" : "var(--muted-foreground)";
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      focusable: false,
      selectable: false,
      zIndex: lit ? 10 : 0,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      style: {
        stroke: color,
        strokeWidth: edgeWidth(edge.weight),
        opacity: hovered === null ? 0.45 : lit ? 0.95 : 0.08,
      },
    };
  });

  return { nodes, edges };
}

function CodemapFlow({
  view,
  onOpen,
}: {
  readonly view: CodemapView;
  readonly onOpen: (id: string) => void;
}) {
  const [layout, setLayout] = useState<{ view: CodemapView; layout: CodemapLayout } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const { fitView } = useReactFlow();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- elkjs lays out asynchronously outside React
  useEffect(() => {
    let cancelled = false;
    void layoutCodemap(view).then((next) => {
      if (!cancelled) setLayout({ view, layout: next });
    });
    return () => {
      cancelled = true;
    };
  }, [view]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- React Flow owns the viewport imperatively
  useEffect(() => {
    if (layout === null) return;
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.12, duration: 240, maxZoom: 1.1 });
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, fitView]);

  const flow = layout === null ? { nodes: [], edges: [] } : buildFlow(layout.layout, hovered);

  return (
    <ReactFlow
      nodes={flow.nodes}
      edges={flow.edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.1}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      onNodeMouseEnter={(_, node) => setHovered(node.id)}
      onNodeMouseLeave={() => setHovered(null)}
      onNodeClick={(_, node) => {
        const item = (node.data as CodemapNodeData).item;
        if (opensInto(item)) onOpen(item.id);
      }}
      className={cn(layout === null || layout.view !== view ? "opacity-60" : "opacity-100")}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--border)" />
    </ReactFlow>
  );
}

export function CodemapCanvas(props: {
  readonly view: CodemapView;
  readonly onOpen: (id: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <CodemapFlow {...props} />
    </ReactFlowProvider>
  );
}
