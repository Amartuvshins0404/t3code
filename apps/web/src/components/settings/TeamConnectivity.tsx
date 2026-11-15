import { canManageTeam, type CloudTeamSummary } from "@t3tools/client-runtime/cloud-auth";
import type { EnvironmentId } from "@t3tools/contracts";
import { RelayTeamConnectivityUrl } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import { useState } from "react";

import {
  useManagedRelayTeamConnectivity,
  useManagedRelayTeamEnvironments,
} from "~/cloud/managedRelayState";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import {
  proxyHost,
  removeTeamConnectivity,
  saveTeamConnectivity,
  TEAM_CONNECTIVITY_SECTION_ID,
  useMachineConnectivity,
} from "../teams/teamConnectivity";
import { teamAccessMessage } from "../teams/teamPresentation";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const isProxyUrl = Schema.is(RelayTeamConnectivityUrl);

export function TeamConnectivitySection({ team }: { readonly team: CloudTeamSummary }) {
  const connectivity = useManagedRelayTeamConnectivity(team.id);
  const admin = canManageTeam(team.role);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const record = connectivity.status === "ready" ? connectivity.record : null;

  const remove = async () => {
    setRemoving(true);
    const cause = await removeTeamConnectivity(team.id).then(
      () => null,
      (error: unknown) => error,
    );
    setRemoving(false);
    setConfirmRemove(false);
    if (cause !== null) {
      toastManager.add({
        type: "error",
        title: "Could not remove the connection",
        description: teamAccessMessage(cause, "Try again in a moment."),
      });
      return;
    }
    toastManager.add({ type: "success", title: "Team connection removed" });
  };

  return (
    <SettingsSection id={TEAM_CONNECTIVITY_SECTION_ID} title="Connectivity">
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Threads shared with this team run through the team's CLI Proxy instead of each owner's
        accounts. Claude and Codex.
      </p>
      {connectivity.status === "loading" ? (
        <div className="px-3 py-3 sm:px-4">
          <Skeleton className="h-8 w-full" />
        </div>
      ) : connectivity.status === "failed" ? (
        <p role="alert" className="px-3 py-2.5 text-xs text-destructive sm:px-4">
          {connectivity.error}
        </p>
      ) : record ? (
        <>
          <SettingsRow
            title={proxyHost(record.url)}
            description={`Set by ${record.updatedBy.name} ${formatRelativeTimeLabel(record.updatedAt)}`}
            control={
              admin ? (
                <>
                  <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
                    Replace
                  </Button>
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    onClick={() => setConfirmRemove(true)}
                  >
                    Remove
                  </Button>
                </>
              ) : null
            }
          />
          <MyMachinesConnectivity organizationId={team.id} />
        </>
      ) : admin ? (
        <SettingsRow
          title="No team connection"
          control={
            <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
              Connect
            </Button>
          }
        />
      ) : (
        <SettingsRow title="No team connection" description="Ask a team admin to connect one." />
      )}

      {editing ? (
        <ConnectProxyDialog
          team={team}
          replacing={record !== null}
          onClose={() => setEditing(false)}
        />
      ) : null}

      <AlertDialog
        open={confirmRemove}
        onOpenChange={(open) => {
          if (!open && !removing) setConfirmRemove(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the team connection?</AlertDialogTitle>
            <AlertDialogDescription>
              Shared threads go back to each owner's accounts within a few minutes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={removing} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={removing} onClick={() => void remove()}>
              {removing ? "Removing…" : "Remove"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

function ConnectProxyDialog({
  team,
  replacing,
  onClose,
}: {
  readonly team: CloudTeamSummary;
  readonly replacing: boolean;
  readonly onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedUrl = url.trim();
  const trimmedKey = accessKey.trim();
  const urlValid = isProxyUrl(trimmedUrl);
  const canSubmit = urlValid && trimmedKey.length > 0 && !pending;

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    const cause = await saveTeamConnectivity({
      organizationId: team.id,
      url: trimmedUrl,
      clientKey: trimmedKey,
    }).then(
      () => null,
      (failure: unknown) => failure,
    );
    setAccessKey("");
    setPending(false);
    if (cause !== null) {
      setError(teamAccessMessage(cause, "Could not save the connection."));
      return;
    }
    toastManager.add({ type: "success", title: `${team.name} is connected` });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{replacing ? "Replace team connection" : "Connect a CLI Proxy"}</DialogTitle>
          <DialogDescription>
            The key is kept on the relay for {team.name} and is never shown again.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="team-connectivity-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="team-connectivity-url">Address</Label>
              <Input
                id="team-connectivity-url"
                placeholder="https://proxy.example.com"
                value={url}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setUrl(event.target.value)}
              />
              {trimmedUrl !== "" && !urlValid ? (
                <p className="text-xs text-muted-foreground">
                  Use an http or https address with no user name, query or #.
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="team-connectivity-key">Access key</Label>
              <Input
                id="team-connectivity-key"
                type="password"
                value={accessKey}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setAccessKey(event.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form="team-connectivity-form" disabled={!canSubmit}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function MyMachinesConnectivity({ organizationId }: { readonly organizationId: string }) {
  const teamMachines = useManagedRelayTeamEnvironments(organizationId);
  const mine = (teamMachines.data ?? []).filter((machine) => machine.isOwner);
  return mine.map((machine) => (
    <MachineConnectivityLine
      key={machine.environmentId}
      environmentId={machine.environmentId}
      label={machine.label}
      organizationId={organizationId}
    />
  ));
}

function MachineConnectivityLine({
  environmentId,
  label,
  organizationId,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly organizationId: string;
}) {
  const machine = useMachineConnectivity(environmentId);
  return (
    <p className="px-3 py-1.5 text-xs text-muted-foreground sm:px-4">
      {machineConnectivityLine(machine, label, organizationId)}
    </p>
  );
}

function machineConnectivityLine(
  machine: ReturnType<typeof useMachineConnectivity>,
  label: string,
  organizationId: string,
): string {
  switch (machine.kind) {
    case "offline":
      return `${label} is offline.`;
    case "outdated":
      return `Update ${label} to use the team connection.`;
    case "checking":
      return `Checking ${label}…`;
    case "failed":
      return `${label} cannot get the key right now.`;
    case "answered": {
      const state = machine.status.organizations.find(
        (entry) => entry.organizationId === organizationId,
      )?.state;
      if (state === "ready") return `Ready on ${label}.`;
      if (state === "unavailable") return `${label} cannot get the key right now.`;
      return `${label} has not picked it up yet.`;
    }
  }
}
