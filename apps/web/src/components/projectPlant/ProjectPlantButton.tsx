import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type ProjectId,
  type ProjectPlantStatus,
  type ThreadId,
  projectPlantUnavailableMessage,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareShareIcon, ShovelIcon, SproutIcon } from "lucide-react";
import { useState } from "react";

import { useProject } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useStartProjectPlant } from "./useStartProjectPlant";

type PlantButtonState =
  | { readonly kind: "plant" | "unplant" }
  | { readonly kind: "open"; readonly threadId: ThreadId }
  | { readonly kind: "disabled"; readonly reason: string };

function plantButtonState(input: {
  readonly status: ProjectPlantStatus | null;
  readonly error: string | null;
  readonly permitted: boolean;
}): PlantButtonState {
  if (!input.permitted)
    return { kind: "disabled", reason: "This connection cannot start agent threads here." };
  if (input.error !== null) return { kind: "disabled", reason: input.error };
  const status = input.status;
  if (status === null) return { kind: "disabled", reason: "Reading the default branch…" };
  switch (status._tag) {
    case "planted":
    case "not_planted":
      if (status.openThread !== null) return { kind: "open", threadId: status.openThread.threadId };
      return { kind: status._tag === "planted" ? "unplant" : "plant" };
    case "blocked":
      return {
        kind: "disabled",
        reason: `${status.file} on the default branch is not agent-trust's, so Plant would stop.`,
      };
    case "unavailable":
      return { kind: "disabled", reason: projectPlantUnavailableMessage(status.reason) };
  }
}

const LABELS = {
  plant: { text: "Plant", icon: SproutIcon },
  unplant: { text: "Unplant", icon: ShovelIcon },
  open: { text: "Open plant thread", icon: MessageSquareShareIcon },
  disabled: { text: "Plant", icon: SproutIcon },
};

export function ProjectPlantButton(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  size?: "panel" | "header" | "row";
}) {
  const { environmentId, projectId } = props;
  const size = props.size ?? "row";
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const permitted = useAtomValue(projectEnvironment.plant.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    projectEnvironment.readPlant({ environmentId, input: { projectId } }),
  );
  const startPlant = useStartProjectPlant();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const state = plantButtonState({ status: query.data, error: query.error, permitted });
  const { text, icon: Icon } = LABELS[state.kind];
  const disabled = state.kind === "disabled" || starting;

  const onClick = async () => {
    if (disabled) return;
    if (state.kind === "open") {
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: state.threadId },
      });
      return;
    }
    if (state.kind !== "plant" && state.kind !== "unplant") return;
    setStarting(true);
    await startPlant(
      { environmentId, projectId, projectName: project?.title ?? "this project" },
      state.kind,
    );
    setStarting(false);
  };

  const label = state.kind === "open" ? text : `${text} agent-trust`;
  const button =
    size === "panel" ? (
      <ThreadDetailsControl
        size="sm"
        variant="ghost"
        part="row"
        aria-disabled={disabled ? "true" : undefined}
        aria-label={label}
        onClick={() => void onClick()}
      >
        <Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>{text}</span>
      </ThreadDetailsControl>
    ) : (
      <Button
        size="sm"
        variant={size === "header" ? "ghost" : "outline"}
        aria-disabled={disabled ? "true" : undefined}
        aria-label={label}
        onClick={() => void onClick()}
      >
        <Icon aria-hidden />
        {text}
      </Button>
    );

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="top">{state.kind === "disabled" ? state.reason : label}</TooltipPopup>
    </Tooltip>
  );
}
