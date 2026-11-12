import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  CLIPROXY_INSTALL_URL,
  CliproxyLocalError,
  type CliproxyLocalFailureReason,
  type CliproxyLocalStatus,
  type EnvironmentId,
  type SecretReference,
  type UnifiedSettings,
  type UsageLimitSourceId,
} from "@t3tools/contracts";
import { usageLimitSourceIdFromUrl } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { CheckIcon, CircleIcon, CopyIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { useContext, useState } from "react";

import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
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

const isLocalError = Schema.is(CliproxyLocalError);

type Busy = "install" | "connect" | "setNewKey" | null;
type CheckState = "done" | "running" | "failed" | "waiting";

const statusAtom = (environmentId: EnvironmentId) =>
  cliproxyLocalStatus({ environmentId, input: {} });

function failureMessage(reason: CliproxyLocalFailureReason | null, machine: string): string {
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
  sources,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
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
          />
        ) : (
          <RemoteHubForm
            environmentId={environmentId}
            sources={sources}
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
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onUseRemote: () => void;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const status = AsyncResult.getOrElse(useAtomValue(statusAtom(environmentId)), () => null);
  const canWrite = useAtomValue(cliproxyLocalInstall.permissionAtom(environmentId));
  const install = useAtomCommand(cliproxyLocalInstall, { reportFailure: false });
  const connect = useAtomCommand(cliproxyLocalConnect, { reportFailure: false });
  const setNewKey = useAtomCommand(cliproxyLocalSetNewKey, { reportFailure: false });
  const canCopyKey = useAtomValue(cliproxyLocalRevealKey.permissionAtom(environmentId));
  const revealKey = useAtomCommand(cliproxyLocalRevealKey, { reportFailure: false });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "management key" });
  const [copyFailed, setCopyFailed] = useState(false);
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
      return;
    }
    const error = Cause.squash(result.cause);
    setFailure({ reason: isLocalError(error) ? error.reason : null });
  };

  const copyKey = async (sourceId: UsageLimitSourceId) => {
    setCopyFailed(false);
    const result = await revealKey({ environmentId, input: { sourceId } });
    if (result._tag === "Success") copyToClipboard(result.value, undefined);
    else setCopyFailed(true);
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
        {failureMessage(failure.reason, environmentLabel)}
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
          {copyFailed ? (
            <p className="text-sm text-destructive" role="alert">
              Couldn't read the key. Try again.
            </p>
          ) : null}
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
                href={new URL("management.html", `${status.url}/`).toString()}
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
  sources,
  onUseLocal,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly sources: UnifiedSettings["usageLimitSources"];
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
        [usageLimitSourceIdFromUrl(trimmedUrl, sources)]: {
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
          Add hub
        </Button>
      </DialogFooter>
    </>
  );
}
