import type { ProjectBoardCard } from "@t3tools/client-runtime/state/projects";
import { Link } from "@tanstack/react-router";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { RelativeTime } from "../RelativeTime";
import {
  ChangeRequestStatusIcon,
  linkedPullRequestSnapshotStatus,
  prStatusIndicator,
} from "../ThreadStatusIndicators";
import { projectBoardReasonLabel } from "./projectBoardPresentation";

export function ProjectBoardCardView({
  card,
  timestamp,
  place,
}: {
  readonly card: ProjectBoardCard;
  readonly timestamp: string | null;
  readonly place?: string | undefined;
}) {
  const { thread, pullRequest } = card;
  const linked = pullRequest === null ? null : linkedPullRequestSnapshotStatus(pullRequest);
  const status = prStatusIndicator(linked?.pr ?? null, linked?.sourceControlProvider);
  return (
    <li>
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId: thread.environmentId, threadId: thread.id }}
        className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3 hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="line-clamp-2 text-sm font-medium text-foreground">{thread.title}</span>
        {place === undefined ? null : (
          <span className="truncate text-xs text-muted-foreground">{place}</span>
        )}
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{projectBoardReasonLabel(card)}</span>
          {timestamp === null ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">
                <RelativeTime timestamp={timestamp} />
              </span>
            </>
          )}
        </span>
        {pullRequest === null ? null : (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={`inline-flex shrink-0 ${status?.colorClass ?? "text-muted-foreground"}`}
            >
              {linked === null ? (
                <PullRequestGlyph.pullRequest aria-hidden className="size-3" />
              ) : (
                <ChangeRequestStatusIcon
                  state={linked.pr.state}
                  isDraft={linked.pr.isDraft}
                  className="size-3"
                />
              )}
            </span>
            <span className="shrink-0 tabular-nums">#{pullRequest.number}</span>
            {pullRequest.snapshot === null ? null : (
              <span className="truncate">{pullRequest.snapshot.title}</span>
            )}
          </span>
        )}
      </Link>
    </li>
  );
}
