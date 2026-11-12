import type { CloudAuth } from "@t3tools/client-runtime/cloud-auth";
import { useState, useSyncExternalStore } from "react";

import { useCloudAuth } from "../../cloud/cloudAuth";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { T3ConnectAccountDevices } from "./T3ConnectAccountDevices";
import { T3ConnectAccountEnvironments } from "./T3ConnectAccountEnvironments";

export type T3ConnectAccountPageUrl = "t3-connect" | "mobile-clients";

let openPage: T3ConnectAccountPageUrl | null = null;
const listeners = new Set<() => void>();

function setOpenPage(page: T3ConnectAccountPageUrl | null) {
  openPage = page;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openT3ConnectAccountPage(page: T3ConnectAccountPageUrl = "t3-connect") {
  setOpenPage(page);
}

export function useT3ConnectAccountPage(): {
  readonly open: ((page?: T3ConnectAccountPageUrl) => void) | null;
} {
  const { isSignedIn } = useCloudAuth();
  return { open: isSignedIn ? openT3ConnectAccountPage : null };
}

export function T3ConnectAccountDialog({ auth }: { readonly auth: CloudAuth }) {
  const page = useSyncExternalStore(subscribe, () => openPage);
  const { user } = useCloudAuth();
  const [signingOut, setSigningOut] = useState(false);
  const open = page !== null && user !== null;

  const signOut = () => {
    setSigningOut(true);
    void auth.signOut().finally(() => {
      setSigningOut(false);
      setOpenPage(null);
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : setOpenPage(null))}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>T3 Connect account</DialogTitle>
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-sm text-muted-foreground">
              {user?.name ? `${user.name} · ${user.email}` : user?.email}
            </p>
            <Button size="sm" variant="outline" disabled={signingOut} onClick={signOut}>
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
          </div>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <ToggleGroup
              aria-label="Account section"
              value={page ? [page] : []}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "t3-connect" || value === "mobile-clients") setOpenPage(value);
              }}
            >
              <Toggle value="t3-connect">Environments</Toggle>
              <Toggle value="mobile-clients">Mobile clients</Toggle>
            </ToggleGroup>
            {page === "mobile-clients" ? (
              <T3ConnectAccountDevices />
            ) : (
              <T3ConnectAccountEnvironments />
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
