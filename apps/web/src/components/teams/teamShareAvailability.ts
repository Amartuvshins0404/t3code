import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  ScopedThreadRef,
  TeamThreadAccess,
  ThreadTeamShare,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { readCloudTeamsState, useCloudTeamsState } from "~/cloud/cloudTeams";
import { teammateConnectionAtom } from "~/cloud/teamWorkspace";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { environmentThreadShells } from "~/state/threads";

const canShareWithTeamAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(serverEnvironment.setThreadTeamShare.permissionAtom(environmentId)) &&
      !get(teammateConnectionAtom(environmentId)),
  ).pipe(Atom.withLabel(`team-share:available:${environmentId}`)),
);

const CANNOT_SHARE_ATOM = Atom.make(false).pipe(Atom.withLabel("team-share:unavailable"));

export function useCanShareWithTeam(environmentId: EnvironmentId | null): boolean {
  const signedIn = useCloudTeamsState().status !== "signedOut";
  const allowed = useAtomValue(
    environmentId === null ? CANNOT_SHARE_ATOM : canShareWithTeamAtom(environmentId),
  );
  return signedIn && allowed;
}

export function readCanShareWithTeam(environmentId: EnvironmentId): boolean {
  return (
    readCloudTeamsState().status !== "signedOut" &&
    appAtomRegistry.get(canShareWithTeamAtom(environmentId))
  );
}

const NO_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("team-share:no-thread"),
);

function shareKey(share: ThreadTeamShare | null | undefined): string {
  return share ? `${share.organizationId}\n${share.access}` : "";
}

export function useThreadTeamShare(
  threadRef: ScopedThreadRef | null,
): { readonly organizationId: string; readonly access: TeamThreadAccess } | null {
  const key = useAtomValue(
    threadRef === null ? NO_SHELL_ATOM : environmentThreadShells.quietThreadShellAtom(threadRef),
    (shell) => shareKey(shell?.source.teamShare),
  );
  if (key === "") return null;
  const [organizationId = "", access = "view"] = key.split("\n");
  return { organizationId, access: access === "steer" ? "steer" : "view" };
}

export function readThreadTeamShare(threadRef: ScopedThreadRef): ThreadTeamShare | null {
  return (
    appAtomRegistry.get(environmentThreadShells.quietThreadShellAtom(threadRef))?.source
      .teamShare ?? null
  );
}
