import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

export function useOpenMasterAgent(input: {
  readonly preferredEnvironmentId: EnvironmentId | null;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}): (() => Promise<void>) | null {
  const serverConfigs = useServerConfigs();
  const selectDetail = useSelectWorkspaceDetail();
  const ensure = useAtomCommand(projectEnvironment.ensureMasterAgent, { reportFailure: false });
  const supported = (environmentId: EnvironmentId) =>
    input.connectedEnvironmentIds.includes(environmentId) &&
    serverConfigs.get(environmentId)?.masterAgentThreadId !== undefined;
  const environmentId =
    input.preferredEnvironmentId === null
      ? (input.connectedEnvironmentIds.find(supported) ?? null)
      : supported(input.preferredEnvironmentId)
        ? input.preferredEnvironmentId
        : null;
  const allowed = useAtomValue(projectEnvironment.ensureMasterAgent.permissionAtom(environmentId));
  if (environmentId === null || !allowed) return null;
  return async () => {
    const result = await ensure({ environmentId, input: {} });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not open the agent",
        failure instanceof Error ? failure.message : "The server could not open it.",
      );
      return;
    }
    selectDetail({
      name: "Thread",
      params: { environmentId: String(environmentId), threadId: String(result.value.threadId) },
    });
  };
}
