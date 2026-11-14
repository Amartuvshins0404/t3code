import type { ReactNode } from "react";

import { getCloudAuth } from "../../cloud/cloudAuth";
import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { CloudSignInDialog } from "./CloudSignInDialog";
import { T3ConnectAccountDialog } from "./T3ConnectAccountDialog";
import { TeamDialogsHost } from "../teams/TeamDialogs";

export default function CloudAuthShell({ children }: { readonly children: ReactNode }) {
  const auth = getCloudAuth();
  return (
    <ManagedRelayAuthProvider>
      {children}
      {auth ? (
        <>
          <CloudSignInDialog auth={auth} />
          <T3ConnectAccountDialog auth={auth} />
          <TeamDialogsHost />
        </>
      ) : null}
    </ManagedRelayAuthProvider>
  );
}
