import {
  type ProjectId,
  TEAM_AGENT_QUESTION_MAX_LENGTH,
  type TeamPerson,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useTeamMachines } from "~/cloud/teamWorkspace";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { askTeamAgent, teamAgentMessage, useTeamAgentStatuses } from "./teamAgents";
import { useSelfUserId } from "./teamPresence";
import { closeTeamDialog, useTeamUiStore } from "./teamUiStore";

export function AskAgentDialogHost() {
  const dialog = useTeamUiStore((state) => state.dialog);
  if (dialog?.kind !== "ask-agent") return null;
  return (
    <AskAgentDialog
      key={`${dialog.teamId}:${dialog.person.userId}`}
      teamId={dialog.teamId}
      person={dialog.person}
    />
  );
}

function questionProblem(text: string): string | null {
  if (text.startsWith("/")) return "Questions cannot start with /.";
  if (text.length > TEAM_AGENT_QUESTION_MAX_LENGTH) return "This question is too long.";
  return null;
}

function AskAgentDialog({
  teamId,
  person,
}: {
  readonly teamId: string;
  readonly person: TeamPerson;
}) {
  const navigate = useNavigate();
  const state = useTeamMachines();
  const machines =
    state.status === "personal" || state.teamId !== teamId
      ? []
      : state.machines.filter((machine) => machine.owner.userId === person.userId);
  const status = useTeamAgentStatuses(teamId, [person.userId], machines).get(person.userId);
  const self = person.userId === useSelfUserId();
  const [text, setText] = useState("");
  const [pickedProjectId, setPickedProjectId] = useState<ProjectId | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = status?.kind === "ready" ? status.agent : null;
  const project =
    agent?.projects.find((candidate) => candidate.projectId === pickedProjectId) ??
    agent?.projects[0] ??
    null;
  const trimmed = text.trim();
  const problem = trimmed === "" ? null : questionProblem(trimmed);
  const canSend = status?.kind === "ready" && trimmed !== "" && problem === null && !pending;
  const name = self ? "your agent" : `${person.name}'s agent`;

  const send = async () => {
    if (!canSend) return;
    setPending(true);
    setError(null);
    const result = await askTeamAgent({
      environmentId: status.environmentId,
      organizationId: teamId,
      projectId: project?.projectId ?? null,
      text: trimmed,
    }).then(
      (threadId) => ({ ok: true as const, threadId }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    setPending(false);
    if (!result.ok) {
      setError(teamAgentMessage(result.cause, person, self));
      return;
    }
    closeTeamDialog();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: status.environmentId, threadId: result.threadId },
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : closeTeamDialog())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{self ? "Ask your agent" : `Ask ${person.name}'s agent`}</DialogTitle>
          <DialogDescription>
            {agent === null
              ? `${self ? "Your" : `${person.name}'s`} agent is not available right now.`
              : agent.projects.length > 1
                ? "It answers from the code and thread history. It cannot change anything."
                : `Answers about ${project?.title ?? "this project"}. It cannot change anything.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="ask-agent-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            {agent !== null && agent.projects.length > 1 ? (
              <div className="grid gap-1.5">
                <Label htmlFor="ask-agent-project">Project</Label>
                <Select
                  value={project?.projectId ?? null}
                  onValueChange={(next: ProjectId | null) => setPickedProjectId(next)}
                >
                  <SelectTrigger id="ask-agent-project">
                    <SelectValue>
                      {(value: ProjectId | null) =>
                        agent.projects.find((candidate) => candidate.projectId === value)?.title
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {agent.projects.map((candidate) => (
                      <SelectItem key={candidate.projectId} value={candidate.projectId}>
                        {candidate.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="ask-agent-question">Question</Label>
              <Textarea
                id="ask-agent-question"
                autoFocus
                value={text}
                readOnly={pending}
                placeholder={`Ask ${name} about the code or past work`}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) {
                    return;
                  }
                  event.preventDefault();
                  void send();
                }}
              />
            </div>
            {(problem ?? error) ? (
              <p role="alert" className="text-xs text-destructive">
                {problem ?? error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={closeTeamDialog} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form="ask-agent-form" disabled={!canSend}>
            {pending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
