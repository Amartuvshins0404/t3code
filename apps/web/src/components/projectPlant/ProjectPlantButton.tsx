import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareShareIcon, ShovelIcon, SproutIcon } from "lucide-react";
import { useState } from "react";

import { useProject, useQuietThreadShell } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { plantButtonState, plantOpenThreadId } from "./ProjectPlantButton.logic";
import { useStartProjectPlant } from "./useStartProjectPlant";

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
  const openThreadId = plantOpenThreadId(query.data);
  const openThread = useQuietThreadShell(
    openThreadId === null ? null : scopeThreadRef(environmentId, openThreadId),
  );
  const state = plantButtonState({
    status: query.data,
    error: query.error,
    permitted,
    openThreadKnown: openThread !== null,
  });
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
