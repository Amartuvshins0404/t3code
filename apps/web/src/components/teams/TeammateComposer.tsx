import type { TeamWorkspace } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProviderInteractionMode, RuntimeMode, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useCloudTeamsState } from "~/cloud/cloudTeams";
import { useTeamMachine } from "~/cloud/teamWorkspace";
import { cn, newMessageId } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { agentAnswersOff, useAgentConversation, useMachineAgentState } from "./teamAgents";
import { teamAccessMessage } from "./teamPresentation";
import { teammateConnectivityLine, useThreadConnectivity } from "./teamConnectivity";
import { useThreadTeamShare } from "./teamShareAvailability";
import { setTeammateTyping } from "./TeamThreadPresence";

export function TeammateComposer({
  threadRef,
  mode,
  running,
  canInterrupt,
  runtimeMode,
  interactionMode,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly mode: Exclude<TeamWorkspace.ThreadComposerMode, "owner">;
  readonly running: boolean;
  readonly canInterrupt: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}) {
  const ownerName = useTeamMachine(threadRef.environmentId)?.owner.name ?? "the owner";
  const conversation = useAgentConversation(threadRef);
  const agentState = useMachineAgentState(
    threadRef.environmentId,
    conversation?.organizationId ?? null,
  );
  const agentOff = conversation !== null && agentAnswersOff(agentState);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const { environmentId, threadId } = threadRef;
  const updateText = (next: string) => {
    setText(next);
    setTeammateTyping({ environmentId, threadId }, next.trim() !== "");
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears my typing state when I leave the thread
  useEffect(
    () => () => setTeammateTyping({ environmentId, threadId }, false),
    [environmentId, threadId],
  );

  if (mode === "unshared") {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">This thread is no longer shared.</p>
    );
  }
  if (agentOff) {
    return (
      <div className="flex flex-col gap-1 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          {agentState.kind === "answered" && agentState.agent?.claudeOutdated === true
            ? `${ownerName} needs to update Claude Code for their agent.`
            : `${ownerName}'s agent is off.`}
        </p>
        <TeammateConnectivityLine threadRef={threadRef} ownerName={ownerName} />
      </div>
    );
  }
  if (mode === "view") {
    return (
      <div className="flex flex-col gap-1 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          View only. Ask {ownerName} for Steer to send messages.
        </p>
        <TeammateConnectivityLine threadRef={threadRef} ownerName={ownerName} />
      </div>
    );
  }

  const trimmed = text.trim();
  const send = async (dispatchMode: "auto" | "queue" = "auto") => {
    if (trimmed === "" || sending) return;
    setSending(true);
    const result = await startTurn({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        message: { messageId: newMessageId(), role: "user", text: trimmed, attachments: [] },
        runtimeMode,
        interactionMode,
        dispatchMode,
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      updateText("");
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title: "Message not sent",
      description: teamAccessMessage(squashAtomCommandFailure(result), "Try again."),
    });
  };

  const stop = async () => {
    setStopping(true);
    const result = await interruptTurn({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    setStopping(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title: "Could not stop the agent",
      description: teamAccessMessage(squashAtomCommandFailure(result), "Try again."),
    });
  };

  return (
    <form
      className="flex flex-col gap-2 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        unstyled
        aria-label="Message"
        placeholder={
          conversation !== null
            ? "Ask a follow-up"
            : running
              ? "Steer the agent while it works"
              : "Send a message"
        }
        value={text}
        readOnly={sending}
        onChange={(event) => updateText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          void send();
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <TeammateConnectivityLine threadRef={threadRef} ownerName={ownerName} />
        {running && canInterrupt ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={stopping}
            onClick={() => void stop()}
          >
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
        {running ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={trimmed === "" || sending}
            onClick={() => void send("queue")}
          >
            Queue
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={trimmed === "" || sending}>
          {sending ? "Sending…" : running ? "Steer" : "Send"}
        </Button>
      </div>
    </form>
  );
}

function TeammateConnectivityLine({
  threadRef,
  ownerName,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly ownerName: string;
}) {
  const organizationId = useThreadTeamShare(threadRef)?.organizationId ?? "";
  const teamsState = useCloudTeamsState();
  const teamName =
    (teamsState.status === "signedOut" ? [] : teamsState.teams).find(
      (team) => team.id === organizationId,
    )?.name ?? "the team";
  const connectivity = useThreadConnectivity(threadRef, organizationId);
  const line = teammateConnectivityLine(connectivity, teamName, ownerName);
  if (line === null) return null;
  return (
    <p
      className={cn(
        "me-auto text-xs",
        connectivity.kind === "unavailable" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {line}
    </p>
  );
}
