import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { useIsTeammateEnvironment, useTeamMachine } from "~/cloud/teamWorkspace";
import { useComposerDraftStore } from "~/composerDraftStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { useThreadTeamShare } from "./TeamShareControls";
import { PresenceAvatars, typingLine, usePresencePeople, useSelfUserId } from "./teamPresence";

const useTeammateTypingStore = create<{ readonly threadKey: string | null }>(() => ({
  threadKey: null,
}));

export function setTeammateTyping(threadRef: ScopedThreadRef, typing: boolean): void {
  const threadKey = scopedThreadKey(threadRef);
  const current = useTeammateTypingStore.getState().threadKey;
  if (typing && current !== threadKey) useTeammateTypingStore.setState({ threadKey });
  if (!typing && current === threadKey) useTeammateTypingStore.setState({ threadKey: null });
}

function reportPresence(
  threadRef: ScopedThreadRef,
  input: { readonly threadId?: ScopedThreadRef["threadId"]; readonly typing: boolean },
) {
  void runAtomCommand(
    appAtomRegistry,
    serverEnvironment.reportTeamPresence,
    { environmentId: threadRef.environmentId, input },
    { reportFailure: false },
  );
}

export function TeamPresenceReporter({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shared = useThreadTeamShare(threadRef) !== null;
  const teammate = useIsTeammateEnvironment(threadRef.environmentId);
  const threadKey = scopedThreadKey(threadRef);
  const draftTyping = useComposerDraftStore(
    (state) => (state.getComposerDraft(threadRef)?.prompt.trim().length ?? 0) > 0,
  );
  const teammateTyping = useTeammateTypingStore((state) => state.threadKey === threadKey);
  const typing = teammate ? teammateTyping : draftTyping;
  const { environmentId, threadId } = threadRef;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the machine which shared thread is open and whether I am typing, only when either changes
  useEffect(() => {
    if (!shared) return;
    reportPresence({ environmentId, threadId }, { threadId, typing });
  }, [shared, environmentId, threadId, typing]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the machine I left the shared thread when it closes
  useEffect(() => {
    if (!shared) return;
    return () => reportPresence({ environmentId, threadId }, { typing: false });
  }, [shared, environmentId, threadId]);

  return null;
}

function usePresenceFilter(threadRef: ScopedThreadRef) {
  const teammate = useIsTeammateEnvironment(threadRef.environmentId);
  const owner = useTeamMachine(threadRef.environmentId)?.owner ?? null;
  const selfUserId = useSelfUserId();
  return { threadId: threadRef.threadId, selfUserId, selfIsOwner: !teammate, owner };
}

export function ThreadPresenceAvatars({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shared = useThreadTeamShare(threadRef) !== null;
  const filter = usePresenceFilter(threadRef);
  const people = usePresencePeople(shared ? threadRef.environmentId : null, filter);
  return <PresenceAvatars people={people} size="sm" />;
}

export function ThreadTypingLine({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shared = useThreadTeamShare(threadRef) !== null;
  const filter = usePresenceFilter(threadRef);
  const typing = usePresencePeople(shared ? threadRef.environmentId : null, {
    ...filter,
    typingOnly: true,
  });
  const line = typingLine(typing);
  if (line === null) return null;
  return <p className="px-4 pb-1 text-xs text-muted-foreground">{line}</p>;
}
