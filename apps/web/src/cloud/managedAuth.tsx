import { type CloudAuthSource, cloudAuthSource } from "@t3tools/client-runtime/cloud-auth";
import {
  createCloudAccountService,
  ManagedRelay,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, type ReactNode } from "react";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { getCloudAuth } from "./cloudAuth";

export function deactivateManagedRelayAuthentication(): void {
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readIdentityToken: () => Promise<string | null>,
): void {
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readIdentityToken,
  });
}

const managedRelayAccountService = createCloudAccountService<CloudAuthSource>({
  deactivate: deactivateManagedRelayAuthentication,
  detach: deactivateManagedRelayAuthentication,
  cleanUp: async () => {
    const results = await Promise.all([
      runAtomCommand(appAtomRegistry, environmentCatalog.removeRelayEnvironments, undefined, {
        reportFailure: false,
        reportDefect: false,
      }),
      settleAsyncResult(() =>
        runtime.runPromiseExit(
          ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
        ),
      ),
    ]);
    for (const result of results) {
      reportAtomCommandResult(result, { label: "cloud account cleanup" });
    }
  },
  activate: ({ source, accountId }) =>
    activateManagedRelayAuthentication(accountId, () => source.auth.getRelayIdentityToken()),
});

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const auth = getCloudAuth();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the cloud auth session to the managed relay account service for the provider's lifetime
  useEffect(
    () => (auth ? managedRelayAccountService.attach(cloudAuthSource(auth)) : undefined),
    [auth],
  );
  return children;
}
