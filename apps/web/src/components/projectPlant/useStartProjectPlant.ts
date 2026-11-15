import type { EnvironmentId, ProjectId, ProjectPlantAction } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";

import { readLocalApi } from "../../localApi";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

export interface ProjectPlantTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectName: string;
}

const UNPLANT_CONFIRMATION = (projectName: string) =>
  [
    `Unplant agent-trust from ${projectName}?`,
    "",
    "An agent opens a pull request that removes agent-trust's workflows. Any branch protection agent-trust added is removed at once, before that pull request merges.",
  ].join("\n");

export function useStartProjectPlant() {
  const plant = useAtomCommand(projectEnvironment.plant, { reportFailure: false });
  const navigate = useNavigate();
  return async (target: ProjectPlantTarget, action: ProjectPlantAction) => {
    if (action === "unplant") {
      const confirmed = await (
        readLocalApi()?.dialogs.confirm(UNPLANT_CONFIRMATION(target.projectName), {
          variant: "destructive",
        }) ?? Promise.resolve(false)
      ).catch(() => false);
      if (!confirmed) return;
    }
    const result = await plant({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, action },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: action === "plant" ? "Could not plant agent-trust" : "Could not unplant agent-trust",
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: target.environmentId, threadId: result.value.threadId },
    });
  };
}
