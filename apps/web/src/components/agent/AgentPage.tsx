import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";

import { isElectron } from "~/env";
import { useQuietThreadShell } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { primaryMasterAgentThreadIdAtom } from "~/state/masterAgent";
import { projectEnvironment } from "~/state/projects";
import { ThreadRouteView } from "../ThreadRouteView";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

type EnsureOutcome =
  | { readonly kind: "ready"; readonly threadId: ThreadId }
  | { readonly kind: "failed"; readonly message: string };

export function AgentPage() {
  const registry = useContext(RegistryContext);
  const environmentId = usePrimaryEnvironmentId();
  const configThreadId = useAtomValue(primaryMasterAgentThreadIdAtom);
  const [attempt, setAttempt] = useState(0);
  const [ensured, setEnsured] = useState<{
    readonly key: string;
    readonly outcome: EnsureOutcome;
  } | null>(null);
  const key = `${environmentId}:${attempt}`;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server to open the agent thread when the page opens or retries
  useEffect(() => {
    if (environmentId === null) return;
    let current = true;
    void ensureMasterAgent(registry, environmentId).then((outcome) => {
      if (current && outcome !== null) setEnsured({ key: `${environmentId}:${attempt}`, outcome });
    });
    return () => {
      current = false;
    };
  }, [registry, environmentId, attempt]);

  const outcome = ensured?.key === key ? ensured.outcome : null;
  const configThreadShell = useQuietThreadShell(
    environmentId === null || configThreadId === null
      ? null
      : scopeThreadRef(environmentId, configThreadId),
  );
  const threadId =
    outcome?.kind === "ready"
      ? outcome.threadId
      : configThreadShell !== null && configThreadShell.deletedAt == null
        ? configThreadShell.id
        : null;

  if (environmentId !== null && threadId !== null) {
    return (
      <ThreadRouteView
        target={{ kind: "server", threadRef: scopeThreadRef(environmentId, threadId) }}
        agentPage
      />
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        <WorkspaceBreadcrumb ariaLabel="Agent breadcrumb">
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">Agent</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      {environmentId === null ? (
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <EmptyTitle>No machine for the agent</EmptyTitle>
            <EmptyDescription>
              Connect this app to a T3 Code server to use the agent.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : outcome?.kind === "failed" ? (
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <EmptyTitle>Could not open the agent</EmptyTitle>
            <EmptyDescription>{outcome.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}
    </SidebarInset>
  );
}

async function ensureMasterAgent(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): Promise<EnsureOutcome | null> {
  const command = projectEnvironment.ensureMasterAgent;
  const result = await runAtomCommand(
    registry,
    command,
    { environmentId, input: {} },
    { label: command.label, reportFailure: false, reportDefect: true },
  );
  if (result._tag === "Success") return { kind: "ready", threadId: result.value.threadId };
  if (isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return {
    kind: "failed",
    message: error instanceof Error && error.message !== "" ? error.message : "An error occurred.",
  };
}
