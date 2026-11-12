import type { ReactNode } from "react";

import { getCloudAuth } from "../../cloud/cloudAuth";
import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { CloudSignInDialog } from "./CloudSignInDialog";
import { T3ConnectAccountDialog } from "./T3ConnectAccountDialog";

export default function CloudAuthShell({ children }: { readonly children: ReactNode }) {
  const auth = getCloudAuth();
  return (
    <ManagedRelayAuthProvider>
      {children}
      {auth ? (
        <>
          <CloudSignInDialog auth={auth} />
          <T3ConnectAccountDialog auth={auth} />
        </>
      ) : null}
    </ManagedRelayAuthProvider>
  );
}
