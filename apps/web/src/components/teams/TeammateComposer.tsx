import type { TeamWorkspace } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProviderInteractionMode, RuntimeMode, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useTeamMachine } from "~/cloud/teamWorkspace";
import { newMessageId } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { teamAccessMessage } from "./teamPresentation";
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
  if (mode === "view") {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        View only. Ask {ownerName} for Steer to send messages.
      </p>
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
        placeholder={running ? "Steer the agent while it works" : "Send a message"}
        value={text}
        disabled={sending}
        onChange={(event) => updateText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          void send();
        }}
      />
      <div className="flex items-center justify-end gap-2">
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
