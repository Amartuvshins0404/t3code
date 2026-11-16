import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MasterAgentWatch,
  MasterAgentWatchList,
  MasterAgentWatchState,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useContext } from "react";

import { useQuietThreadShell } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const EMPTY: MasterAgentWatchList = [];

const STATE_LABEL: Record<MasterAgentWatchState, string> = {
  working: "Working",
  waiting_on_tasks: "Waiting on a helper or program",
  in_checks: "Waiting on PR checks",
  needs_you: "Waiting for you",
  done: "Done, telling the agent",
};

export function MasterAgentWatches({ environmentId }: { environmentId: EnvironmentId }) {
  const result = useAtomValue(projectEnvironment.masterAgentWatches({ environmentId, input: {} }));
  const watches = AsyncResult.getOrElse(result, () => EMPTY);
  if (watches.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost-muted" size="compact" />}>
        Watching {watches.length} {watches.length === 1 ? "thread" : "threads"}
      </PopoverTrigger>
      <PopoverPopup align="end" aria-label="Threads the agent is watching">
        <ul className="flex w-72 flex-col gap-1">
          {watches.map((watch) => (
            <WatchRow key={watch.threadId} environmentId={environmentId} watch={watch} />
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}

function WatchRow({
  environmentId,
  watch,
}: {
  environmentId: EnvironmentId;
  watch: MasterAgentWatch;
}) {
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const ref = scopeThreadRef(environmentId, watch.threadId);
  const shell = useQuietThreadShell(ref);
  const command = projectEnvironment.unwatchMasterAgentThread;
  const canStop = useAtomValue(command.permissionAtom(environmentId));
  return (
    <li className="flex items-center gap-2">
      <button
        type="button"
        className="min-w-0 flex-1 rounded-md px-2 py-1 text-left hover:bg-accent"
        onClick={() =>
          void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) })
        }
      >
        <div className="truncate text-sm">{shell?.title ?? "Thread"}</div>
        <div className="truncate text-muted-foreground text-xs">{STATE_LABEL[watch.state]}</div>
      </button>
      {canStop ? (
        <Button
          variant="ghost-muted"
          size="compact"
          onClick={() =>
            void runAtomCommand(
              registry,
              command,
              { environmentId, input: { threadId: watch.threadId } },
              { label: command.label },
            )
          }
        >
          Stop
        </Button>
      ) : null}
    </li>
  );
}
