import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  CLIPROXY_INSTALL_URL,
  CliproxyLocalError,
  type CliproxyLocalFailureReason,
  type CliproxyLocalStatus,
  type EnvironmentId,
  type SecretReference,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
} from "@t3tools/contracts";
import { usageLimitSourceIdFromUrl } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import {
  CheckIcon,
  CircleIcon,
  CopyIcon,
  ExternalLinkIcon,
  WaypointsIcon,
  XIcon,
} from "lucide-react";
import { useContext, useState } from "react";

import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  cliproxyDisconnect,
  cliproxyLocalConnect,
  cliproxyLocalInstall,
  cliproxyLocalRevealKey,
  cliproxyLocalSetNewKey,
  cliproxyLocalStatus,
} from "../../state/cliproxy";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Spinner } from "../ui/spinner";
import { SecretInput } from "./SecretInput";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const isLocalError = Schema.is(CliproxyLocalError);

type Busy = "install" | "connect" | "setNewKey" | null;
type CheckState = "done" | "running" | "failed" | "waiting";

const statusAtom = (environmentId: EnvironmentId) =>
  cliproxyLocalStatus({ environmentId, input: {} });

function proxyPanelUrl(url: string): string | null {
  try {
    return new URL("management.html", `${url.includes("://") ? url : `http://${url}`}/`).toString();
  } catch {
    return null;
  }
}

function useCopyProxyKey(environmentId: EnvironmentId) {
  const canCopyKey = useAtomValue(cliproxyLocalRevealKey.permissionAtom(environmentId));
  const revealKey = useAtomCommand(cliproxyLocalRevealKey, { reportFailure: false });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "management key" });
  const [copyFailed, setCopyFailed] = useState(false);
  const copyKey = async (sourceId: UsageLimitSourceId) => {
    setCopyFailed(false);
    const result = await revealKey({ environmentId, input: { sourceId } });
    if (result._tag === "Success") copyToClipboard(result.value, undefined);
    else setCopyFailed(true);
  };
  return { canCopyKey, copyKey, isCopied, copyFailed };
}

function CopyFailedNote() {
  return (
    <p className="text-sm text-destructive" role="alert">
      Couldn't read the key. Try again.
    </p>
  );
}

export function cliproxyFailureMessage(
  reason: CliproxyLocalFailureReason | null,
  machine: string,
): string {
  switch (reason) {
    case "noHomebrew":
      return `Homebrew isn't on ${machine}. Install it from brew.sh, or install CLIProxyAPI yourself.`;
    case "installFailed":
      return `Homebrew couldn't install CLIProxyAPI. Run "brew install cliproxyapi" on ${machine} to see why.`;
    case "configNotWritable":
      return "Couldn't update the proxy's config file. Check that it can be edited, then try again.";
    case "serviceDidNotStart":
      return `CLIProxyAPI didn't start. Run "brew services restart cliproxyapi" on ${machine} to see why.`;
    case "notRunning":
      return "CLIProxyAPI stopped answering. Start it, then try again.";
    case "keyRejected":
      return "That key didn't work. Check it, or set a new key.";
    case "lockedOut":
      return "Too many wrong keys. The proxy blocks new tries for 30 minutes, or until it restarts.";
    case "saveFailed":
      return "The key works, but saving the hub failed. Try again.";
    case "notConnected":
      return "Connect CLIProxyAPI on this computer first, then try again.";
    case "clientKeyFailed":
      return "The proxy didn't accept a key for the app. Check that it's running, then try again.";
    case null:
      return "Couldn't finish. Try again.";
  }
}

function CheckRow({ label, state }: { readonly label: string; readonly state: CheckState }) {
  return (
    <li
      className={cn(
        "flex items-center gap-2 text-sm",
        state === "done"
          ? "text-foreground"
          : state === "failed"
            ? "text-destructive"
            : "text-muted-foreground",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {state === "done" ? (
          <CheckIcon className="size-3.5 text-success-foreground" />
        ) : state === "failed" ? (
          <XIcon className="size-3.5" />
        ) : state === "running" ? (
          <Spinner size="xs" tone="muted" />
        ) : (
          <CircleIcon className="size-2.5" />
        )}
      </span>
      {label}
    </li>
  );
}

function checkStates(
  status: CliproxyLocalStatus,
  busy: Busy,
  failed: boolean,
): Record<"installed" | "running" | "connected", CheckState> {
  const pending: CheckState = busy !== null ? "running" : failed ? "failed" : "waiting";
  const installed = status.installed ? "done" : pending;
  const running = status.running ? "done" : installed === "done" ? pending : "waiting";
  const connected =
    status.sourceId !== undefined ? "done" : running === "done" ? pending : "waiting";
  return { installed, running, connected };
}

export function CliProxyDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  onConnected,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onConnected?: () => void;
}) {
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .cliproxyLocalSetup === true;
  const [remote, setRemote] = useState(false);
  const close = () => {
    setRemote(false);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setRemote(false);
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>CLI Proxy</DialogTitle>
          <DialogDescription>
            See the quota of every account the proxy pools, next to the providers on{" "}
            {environmentLabel}. Pooling can get accounts banned, so use it at your own risk.
          </DialogDescription>
        </DialogHeader>
        {supported && !remote ? (
          <LocalSetup
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            onUseRemote={() => setRemote(true)}
            onClose={close}
            {...(onConnected ? { onConnected } : {})}
          />
        ) : (
          <RemoteHubForm
            environmentId={environmentId}
            {...(supported ? { onUseLocal: () => setRemote(false) } : {})}
            onClose={close}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function LocalSetup({
  environmentId,
  environmentLabel,
  onUseRemote,
  onClose,
  onConnected,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onUseRemote: () => void;
  readonly onClose: () => void;
  readonly onConnected?: () => void;
}) {
  const registry = useContext(RegistryContext);
  const status = AsyncResult.getOrElse(useAtomValue(statusAtom(environmentId)), () => null);
  const canWrite = useAtomValue(cliproxyLocalInstall.permissionAtom(environmentId));
  const install = useAtomCommand(cliproxyLocalInstall, { reportFailure: false });
  const connect = useAtomCommand(cliproxyLocalConnect, { reportFailure: false });
  const setNewKey = useAtomCommand(cliproxyLocalSetNewKey, { reportFailure: false });
  const { canCopyKey, copyKey, isCopied, copyFailed } = useCopyProxyKey(environmentId);
  const [managementKey, setManagementKey] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<{ reason: CliproxyLocalFailureReason | null } | null>(
    null,
  );
  const [confirmingNewKey, setConfirmingNewKey] = useState(false);

  const run = async (kind: Exclude<Busy, null>) => {
    setBusy(kind);
    setFailure(null);
    const result =
      kind === "install"
        ? await install({ environmentId, input: {} })
        : kind === "setNewKey"
          ? await setNewKey({ environmentId, input: {} })
          : await connect({ environmentId, input: { managementKey: managementKey.trim() } });
    registry.refresh(statusAtom(environmentId));
    setBusy(null);
    if (result._tag === "Success") {
      setManagementKey("");
      if (result.value.sourceId !== undefined) onConnected?.();
      return;
    }
    const error = Cause.squash(result.cause);
    setFailure({ reason: isLocalError(error) ? error.reason : null });
  };

  if (status === null) {
    return (
      <DialogPanel>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="xs" tone="muted" />
          Checking {environmentLabel}…
        </p>
      </DialogPanel>
    );
  }

  const sourceId = status.running ? status.sourceId : undefined;
  const connected = sourceId !== undefined;
  const found = status.running && !connected;
  const checks = checkStates(status, busy === "install" ? busy : null, failure !== null);
  const error =
    failure === null ? null : (
      <p className="text-sm text-destructive" role="alert">
        {cliproxyFailureMessage(failure.reason, environmentLabel)}
      </p>
    );
  const remoteLink = (
    <Button size="xs" variant="link" className="self-start" onClick={onUseRemote}>
      Use a proxy on another machine
    </Button>
  );
  const permissionNote = canWrite ? null : (
    <p className="text-xs text-muted-foreground">
      Only someone who can change this server's settings can set up the proxy.
    </p>
  );

  if (found) {
    return (
      <>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (managementKey.trim() !== "") void run("connect");
            }}
          >
            <div className="flex items-center gap-2 text-sm">
              <CheckIcon className="size-4 text-success-foreground" aria-hidden />
              <span className="text-foreground">Found on this computer</span>
              <span className="truncate text-muted-foreground">{status.url}</span>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cliproxy-local-key">Management key</Label>
              <SecretInput
                id="cliproxy-local-key"
                placeholder="The key you set for the proxy"
                disabled={busy !== null || !canWrite}
                value={managementKey}
                onChange={(event) => setManagementKey(event.target.value)}
                autoFocus
              />
              {status.canSetNewKey ? (
                <Button
                  type="button"
                  size="xs"
                  variant="link"
                  className="self-start"
                  disabled={busy !== null || !canWrite}
                  onClick={() => setConfirmingNewKey(true)}
                >
                  Forgot it? Set a new key
                </Button>
              ) : null}
            </div>
            {busy === "setNewKey" ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner size="xs" tone="muted" />
                Setting a new key and restarting the proxy…
              </p>
            ) : null}
            {error}
            {permissionNote}
            {remoteLink}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy !== null || !canWrite || managementKey.trim() === ""}
            onClick={() => void run("connect")}
          >
            {busy === "connect" ? <Spinner /> : null}
            {busy === "connect" ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
        <AlertDialog open={confirmingNewKey} onOpenChange={setConfirmingNewKey}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Set a new management key?</AlertDialogTitle>
              <AlertDialogDescription>
                The app writes a new key into the proxy's config and restarts it. Other tools that
                use the old key will stop working until you give them the new one. A copy of the old
                config is kept next to it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmingNewKey(false);
                  void run("setNewKey");
                }}
              >
                Set a new key
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </>
    );
  }

  return (
    <>
      <DialogPanel>
        <div className="grid gap-4">
          {connected || busy === "install" || failure !== null ? (
            <ul className="flex flex-col gap-1.5">
              <CheckRow label="Installed" state={checks.installed} />
              <CheckRow label="Running" state={checks.running} />
              <CheckRow label="Connected" state={checks.connected} />
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {status.autoInstall
                ? status.installed
                  ? `CLIProxyAPI is installed on ${environmentLabel} but not running. Start it in the background and connect it here.`
                  : `CLIProxyAPI isn't on ${environmentLabel} yet. Install it with Homebrew, run it in the background, and connect it here.`
                : `CLIProxyAPI isn't running on ${environmentLabel}. Automatic install needs macOS with Homebrew, so install it from its page, start it, then come back.`}
            </p>
          )}
          {connected ? (
            <p className="text-sm text-muted-foreground">
              {canCopyKey
                ? "Add Claude or Codex accounts in the proxy's panel. Sign in with the management key: use Copy key."
                : "Add Claude or Codex accounts in the proxy's panel. Sign in there with the management key."}
            </p>
          ) : null}
          {copyFailed ? <CopyFailedNote /> : null}
          {error}
          {connected ? null : permissionNote}
          {connected ? null : remoteLink}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={onClose}>
          {connected ? "Close" : "Cancel"}
        </Button>
        {sourceId !== undefined && canCopyKey ? (
          <Button variant="outline" onClick={() => void copyKey(sourceId)}>
            <CopyIcon className="size-3.5" aria-hidden />
            {isCopied ? "Copied" : "Copy key"}
          </Button>
        ) : null}
        {connected ? (
          <Button
            render={
              <a
                href={proxyPanelUrl(status.url) ?? undefined}
                target="_blank"
                rel="noreferrer noopener"
              />
            }
          >
            Open panel to add accounts
            <ExternalLinkIcon className="size-3.5" aria-hidden />
          </Button>
        ) : status.autoInstall ? (
          <Button disabled={busy !== null || !canWrite} onClick={() => void run("install")}>
            {busy === "install" ? <Spinner /> : null}
            {busy === "install"
              ? status.installed
                ? "Starting…"
                : "Installing…"
              : status.installed
                ? "Start and connect"
                : "Install and connect"}
          </Button>
        ) : (
          <Button
            render={<a href={CLIPROXY_INSTALL_URL} target="_blank" rel="noreferrer noopener" />}
          >
            Open install page
            <ExternalLinkIcon className="size-3.5" aria-hidden />
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function RemoteHubForm({
  environmentId,
  onUseLocal,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onUseLocal?: () => void;
  readonly onClose: () => void;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const secretSources = useSecretSources(environmentId);
  const [url, setUrl] = useState("");
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>("");
  const [keyValid, setKeyValid] = useState(true);
  const managementKey = typeof keyDraft === "string" ? keyDraft.trim() : keyDraft;
  const trimmedUrl = url.trim();
  const canSave = keyValid && trimmedUrl.length > 0 && managementKey !== "";

  const save = () => {
    if (!canSave) return;
    updateSettings({
      usageLimitSources: {
        [usageLimitSourceIdFromUrl(trimmedUrl)]: {
          kind: "cliproxy",
          url: trimmedUrl,
          managementKey,
          enabled: true,
        },
      },
    });
    onClose();
  };

  return (
    <>
      <DialogPanel>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="usage-source-url">Hub URL</Label>
            <Input
              id="usage-source-url"
              placeholder="https://hub.example.ts.net:8318"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="usage-source-key">Management key</Label>
            <SecretSourceInput
              id="usage-source-key"
              aria-label="Management key"
              value={keyDraft}
              sources={secretSources}
              onChange={(event) => setKeyDraft(event.target.value)}
              onSecretChange={(secret) => setKeyDraft(secret ?? "")}
              onValidityChange={setKeyValid}
            />
          </div>
          {onUseLocal ? (
            <Button
              type="button"
              size="xs"
              variant="link"
              className="self-start"
              onClick={onUseLocal}
            >
              Use the proxy on this computer
            </Button>
          ) : null}
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} disabled={!canSave}>
          Connect
        </Button>
      </DialogFooter>
    </>
  );
}

export function CliProxyProviderRow({
  source,
  selected,
  onSelect,
}: {
  readonly source: UsageLimitSourceConfig;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <div
      data-slot="settings-row"
      className={cn(
        "group flex min-h-18 items-center gap-3 px-3 py-3 transition-colors sm:px-4",
        selected ? "bg-foreground/[0.06]" : "hover:bg-muted/25",
      )}
    >
      <div className="pointer-events-none relative flex min-w-0 flex-1 items-start gap-3 rounded-md text-left">
        <button
          type="button"
          className="pointer-events-auto absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={onSelect}
          aria-label="Select CLI Proxy"
          aria-pressed={selected}
        />
        <WaypointsIcon className="size-5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">CLI Proxy</span>
          <span className="mt-0.5 block truncate text-xs leading-normal text-muted-foreground/80">
            Connected · {source.url}
          </span>
        </span>
      </div>
    </div>
  );
}

export function CliProxyDetails({
  environmentId,
  sourceId,
  source,
  providerNames,
}: {
  readonly environmentId: EnvironmentId;
  readonly sourceId: UsageLimitSourceId;
  readonly source: UsageLimitSourceConfig;
  readonly providerNames: ReadonlyArray<string>;
}) {
  const registry = useContext(RegistryContext);
  const { canCopyKey, copyKey, isCopied, copyFailed } = useCopyProxyKey(environmentId);
  const canDisconnect = useAtomValue(cliproxyDisconnect.permissionAtom(environmentId));
  const disconnect = useAtomCommand(cliproxyDisconnect);
  const [confirming, setConfirming] = useState(false);
  const panelUrl = proxyPanelUrl(source.url);

  return (
    <SettingsSection title="CLI Proxy" icon={<WaypointsIcon className="size-5" aria-hidden />}>
      <SettingsRow
        title="Connected"
        description={<span className="break-all">{source.url}</span>}
        status={copyFailed ? <CopyFailedNote /> : undefined}
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canCopyKey ? (
              <Button size="xs" variant="outline" onClick={() => void copyKey(sourceId)}>
                <CopyIcon className="size-3.5" aria-hidden />
                {isCopied ? "Copied" : "Copy key"}
              </Button>
            ) : null}
            {panelUrl ? (
              <Button
                size="xs"
                variant="outline"
                render={<a href={panelUrl} target="_blank" rel="noreferrer noopener" />}
              >
                Open panel
                <ExternalLinkIcon className="size-3.5" aria-hidden />
              </Button>
            ) : null}
            {canDisconnect ? (
              <Button size="xs" variant="destructive-outline" onClick={() => setConfirming(true)}>
                Disconnect
              </Button>
            ) : null}
          </div>
        }
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect CLI Proxy?</AlertDialogTitle>
            <AlertDialogDescription>
              {providerNames.length > 0
                ? `This also removes ${providerNames.join(" and ")}. The proxy itself keeps running.`
                : "Its accounts leave Limits. The proxy itself keeps running."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                void disconnect({ environmentId, input: {} }).then(() =>
                  registry.refresh(statusAtom(environmentId)),
                );
              }}
            >
              Disconnect
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
