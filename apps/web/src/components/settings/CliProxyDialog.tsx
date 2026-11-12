import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  CLIPROXY_INSTALL_URL,
  type CliproxyAccount,
  CliproxyLocalError,
  type CliproxyLocalFailureReason,
  type CliproxyLocalStatus,
  CliproxyManageError,
  type CliproxyRoutingStrategy,
  type CliproxySignIn,
  type CliproxySignInProvider,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type SecretReference,
  type ServerProviderUsageWindow,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
} from "@t3tools/contracts";
import { usageLimitSourceIdFromUrl } from "@t3tools/shared/serverSettings";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import {
  CheckIcon,
  CircleIcon,
  CopyIcon,
  ExternalLinkIcon,
  PlusIcon,
  WaypointsIcon,
  XIcon,
} from "lucide-react";
import { useContext, useRef, useState } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import {
  cliproxyAccounts,
  cliproxyDisconnect,
  cliproxyLocalConnect,
  cliproxyLocalInstall,
  cliproxyLocalRevealKey,
  cliproxyLocalSetNewKey,
  cliproxyLocalStatus,
  cliproxyRemoveAccount,
  cliproxyRouting,
  cliproxySetAccountEnabled,
  cliproxySetRouting,
  cliproxySignInCancel,
  cliproxySignInStart,
  cliproxySignInStatus,
} from "../../state/cliproxy";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AccountChip } from "../usage/UsageLimitsPooled";
import { providerClients } from "./providerDriverMeta";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
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

const isManageError = Schema.is(CliproxyManageError);

function cliproxyManageFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  switch (isManageError(error) ? error.reason : null) {
    case "notConnected":
      return "The proxy isn't connected anymore. Connect it again.";
    case "unreachable":
      return "The proxy didn't answer. Check that it's running, then try again.";
    case "keyRejected":
      return "The proxy didn't accept the saved key. Disconnect, then connect again with the right key.";
    case "lockedOut":
      return "Too many wrong keys. The proxy blocks new tries for 30 minutes, or until it restarts.";
    case "notFound":
      return "The proxy doesn't have that account anymore. Refresh the list.";
    case "refused":
      return "The proxy refused the request. Check that its management API is on, then try again.";
    case "unexpectedResponse":
      return "The proxy sent an answer the app doesn't understand. Update CLIProxyAPI, then try again.";
    case null:
      return "Couldn't reach the proxy. Try again.";
  }
}

const ROUTING_LABELS: Record<CliproxyRoutingStrategy, string> = {
  "round-robin": "Spread evenly",
  "fill-first": "Use one until it's full",
  "weighted-round-robin": "Weighted",
};

function hubAddress(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `http://${url}`).host || url;
  } catch {
    return url;
  }
}

function cliproxyAccountName(account: CliproxyAccount): string {
  return account.email ?? account.label ?? account.name;
}

function limitSummary(windows: ReadonlyArray<ServerProviderUsageWindow>): string | null {
  const shown = (["session", "weekly"] as const).flatMap((kind) => {
    const window = windows.find((entry) => entry.kind === kind);
    return window ? [`${window.label} ${remainingPercent(window)}% left`] : [];
  });
  return shown.length > 0 ? shown.join(" · ") : null;
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
              Add Claude or Codex accounts in Settings, under Providers → CLI Proxy.
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
        {connected ? null : status.autoInstall ? (
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
  environmentId,
  sourceId,
  source,
  selected,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly sourceId: UsageLimitSourceId;
  readonly source: UsageLimitSourceConfig;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const accountCount = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
  )?.usageLimitSources?.find((snapshot) => snapshot.id === sourceId)?.accounts.length;
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
            Connected ·{" "}
            {accountCount
              ? `${accountCount} ${accountCount === 1 ? "account" : "accounts"}`
              : source.url}
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
  models,
  readOnly,
  onModelEnabledChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly sourceId: UsageLimitSourceId;
  readonly source: UsageLimitSourceConfig;
  readonly providerNames: ReadonlyArray<string>;
  readonly models: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
  }>;
  readonly readOnly: boolean;
  readonly onModelEnabledChange: (
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
    enabled: boolean,
  ) => void;
}) {
  const registry = useContext(RegistryContext);
  const { canCopyKey, copyKey, isCopied, copyFailed } = useCopyProxyKey(environmentId);
  const canDisconnect = useAtomValue(cliproxyDisconnect.permissionAtom(environmentId));
  const canManage = useAtomValue(cliproxyRemoveAccount.permissionAtom(environmentId));
  const disconnect = useAtomCommand(cliproxyDisconnect);
  const startSignIn = useAtomCommand(cliproxySignInStart, { reportFailure: false });
  const readSignIn = useAtomCommand(cliproxySignInStatus, { reportFailure: false });
  const cancelSignIn = useAtomCommand(cliproxySignInCancel, { reportFailure: false });
  const removeAccount = useAtomCommand(cliproxyRemoveAccount, { reportFailure: false });
  const setAccountEnabled = useAtomCommand(cliproxySetAccountEnabled, { reportFailure: false });
  const setRouting = useAtomCommand(cliproxySetRouting, { reportFailure: false });
  const accountsAtom = cliproxyAccounts({ environmentId, input: { sourceId } });
  const routingAtom = cliproxyRouting({ environmentId, input: { sourceId } });
  const accounts = useAtomValue(accountsAtom);
  const routing = useAtomValue(routingAtom);
  const local = AsyncResult.getOrElse(useAtomValue(statusAtom(environmentId)), () => null);
  const limits = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
  )?.usageLimitSources?.find((snapshot) => snapshot.id === sourceId);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState<CliproxyAccount | null>(null);
  const [busyAccount, setBusyAccount] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<CliproxySignIn | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeSignIn = useRef<string | null>(null);
  const panelUrl = proxyPanelUrl(source.url);
  const listed = AsyncResult.getOrElse(accounts, () => null);
  const strategy = AsyncResult.getOrElse(routing, () => null)?.strategy;
  const refreshing = accounts.waiting || routing.waiting;

  const refresh = () => {
    registry.refresh(accountsAtom);
    registry.refresh(routingAtom);
    registry.refresh(statusAtom(environmentId));
  };

  const addAccount = async (provider: CliproxySignInProvider) => {
    setNotice(null);
    const started = await startSignIn({ environmentId, input: { sourceId, provider } });
    if (started._tag !== "Success") {
      setNotice(cliproxyManageFailureMessage(started.cause));
      return;
    }
    const { state, url } = started.value;
    activeSignIn.current = state;
    setSignIn(started.value);
    void ensureLocalApi()
      .shell.openExternal(url)
      .catch(() => undefined);
    while (activeSignIn.current === state) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (activeSignIn.current !== state) return;
      const result = await readSignIn({ environmentId, input: { sourceId, state } });
      if (activeSignIn.current !== state) return;
      if (result._tag === "Success" && result.value.status === "waiting") continue;
      activeSignIn.current = null;
      setSignIn(null);
      if (result._tag !== "Success") setNotice(cliproxyManageFailureMessage(result.cause));
      else if (result.value.status === "failed") {
        setNotice(`Sign-in didn't finish: ${result.value.error ?? "the proxy gave no reason"}.`);
      }
      registry.refresh(accountsAtom);
    }
  };

  const stopSignIn = () => {
    const state = activeSignIn.current;
    activeSignIn.current = null;
    setSignIn(null);
    if (state !== null) void cancelSignIn({ environmentId, input: { sourceId, state } });
  };

  const changeAccount = async (account: CliproxyAccount, change: "toggle" | "remove") => {
    setNotice(null);
    setBusyAccount(account.name);
    const input = { sourceId, name: account.name };
    const result =
      change === "remove"
        ? await removeAccount({ environmentId, input })
        : await setAccountEnabled({
            environmentId,
            input: { ...input, enabled: account.status === "off" },
          });
    setBusyAccount(null);
    if (result._tag !== "Success") setNotice(cliproxyManageFailureMessage(result.cause));
    registry.refresh(accountsAtom);
  };

  const changeRouting = async (next: CliproxyRoutingStrategy) => {
    setNotice(null);
    const result = await setRouting({ environmentId, input: { sourceId, strategy: next } });
    if (result._tag !== "Success") setNotice(cliproxyManageFailureMessage(result.cause));
    registry.refresh(routingAtom);
  };

  const proxyState =
    local?.sourceId !== sourceId ? "Connected" : local.running ? "Running" : "Not running";
  const routingChoices = (["round-robin", "fill-first", "weighted-round-robin"] as const).filter(
    (value) => value !== "weighted-round-robin" || strategy === value,
  );

  return (
    <div className="space-y-6">
      <SettingsSection
        title="CLI Proxy"
        icon={<WaypointsIcon className="size-5" aria-hidden />}
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={refreshing}
            aria-label="Refresh CLI Proxy"
            onClick={refresh}
          >
            <RefreshIcon refreshing={refreshing} />
          </Button>
        }
      >
        <SettingsRow
          title={<span className="break-all">{hubAddress(source.url)}</span>}
          description={proxyState}
          control={
            canDisconnect ? (
              <Button size="xs" variant="destructive-outline" onClick={() => setConfirming(true)}>
                Disconnect
              </Button>
            ) : undefined
          }
        />
        <SettingsRow
          title="Routing"
          description="How the proxy picks an account for each request."
          status={
            AsyncResult.isFailure(routing) ? (
              <p className="text-sm text-destructive" role="alert">
                {cliproxyManageFailureMessage(routing.cause)}
              </p>
            ) : undefined
          }
          control={
            strategy ? (
              <Select
                items={routingChoices.map((value) => ({ value, label: ROUTING_LABELS[value] }))}
                value={strategy}
                disabled={!canManage}
                onValueChange={(value) => {
                  if (value !== null) void changeRouting(value);
                }}
              >
                <SelectTrigger size="xs" className="w-48" aria-label="Routing">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {routingChoices.map((value) => (
                    <SelectItem key={value} value={value}>
                      {ROUTING_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : undefined
          }
        />
        {canCopyKey ? (
          <SettingsRow
            title="Management key"
            description="••••••••"
            status={copyFailed ? <CopyFailedNote /> : undefined}
            control={
              <Button size="xs" variant="outline" onClick={() => void copyKey(sourceId)}>
                <CopyIcon className="size-3.5" aria-hidden />
                {isCopied ? "Copied" : "Copy"}
              </Button>
            }
          />
        ) : null}
      </SettingsSection>
      <SettingsSection
        title="Accounts"
        headerAction={
          canManage ? (
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={signIn !== null}
                onClick={() => void addAccount("claude")}
              >
                <PlusIcon className="size-3.5" aria-hidden />
                Add Claude
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={signIn !== null}
                onClick={() => void addAccount("codex")}
              >
                <PlusIcon className="size-3.5" aria-hidden />
                Add Codex
              </Button>
            </div>
          ) : undefined
        }
      >
        {signIn ? (
          <SettingsRow
            title={
              <span className="flex items-center gap-2">
                <Spinner size="xs" tone="muted" />
                Waiting for sign-in…
              </span>
            }
            description="Finish in the browser on the computer that runs the proxy."
            control={
              <div className="flex items-center justify-end gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void ensureLocalApi().shell.openExternal(signIn.url)}
                >
                  Open sign-in page
                  <ExternalLinkIcon className="size-3.5" aria-hidden />
                </Button>
                <Button size="xs" variant="outline" onClick={stopSignIn}>
                  Cancel
                </Button>
              </div>
            }
          />
        ) : null}
        {notice ? (
          <SettingsRow
            title={
              <span className="text-destructive" role="alert">
                {notice}
              </span>
            }
          />
        ) : null}
        {listed ? (
          listed.length === 0 ? (
            <SettingsRow
              title="No accounts yet"
              description="Add a Claude or Codex account to start pooling."
            />
          ) : (
            listed.map((account) => (
              <CliProxyAccountRow
                key={account.name}
                account={account}
                windows={
                  limits?.accounts.find((entry) => entry.id === account.id)?.usageLimits.windows
                }
                canManage={canManage}
                busy={busyAccount === account.name}
                onToggle={() => void changeAccount(account, "toggle")}
                onRemove={() => setRemoving(account)}
              />
            ))
          )
        ) : AsyncResult.isFailure(accounts) ? (
          <SettingsRow
            title={
              <span className="text-destructive" role="alert">
                {cliproxyManageFailureMessage(accounts.cause)}
              </span>
            }
            control={
              <Button size="xs" variant="outline" onClick={refresh}>
                Try again
              </Button>
            }
          />
        ) : (
          <SettingsRow
            title={
              <span className="flex items-center gap-2 text-muted-foreground">
                <Spinner size="xs" tone="muted" />
                Loading accounts…
              </span>
            }
          />
        )}
      </SettingsSection>
      {models.length > 0 ? (
        <SettingsSection title="Models">
          {models.map(({ instanceId, instance }) => {
            const label = providerClients.get(instance.driver)?.label ?? String(instance.driver);
            return (
              <SettingsRow
                key={instanceId}
                title={label}
                description={`Shows up in the model picker as ${label} (CLI Proxy).`}
                control={
                  <Switch
                    checked={resolveProviderInstanceEnabled(instance)}
                    disabled={readOnly}
                    onCheckedChange={(checked) =>
                      onModelEnabledChange(instanceId, instance, Boolean(checked))
                    }
                    aria-label={`Enable ${label} through CLI Proxy`}
                  />
                }
              />
            );
          })}
        </SettingsSection>
      ) : null}
      {panelUrl ? (
        <p className="px-3 text-xs sm:px-4">
          <a
            href={panelUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Open the proxy's web panel
          </a>
        </p>
      ) : null}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removing ? cliproxyAccountName(removing) : "this account"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The proxy deletes its sign-in. You can add the account again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const account = removing;
                setRemoving(null);
                if (account) void changeAccount(account, "remove");
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
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
    </div>
  );
}

function CliProxyAccountRow({
  account,
  windows,
  canManage,
  busy,
  onToggle,
  onRemove,
}: {
  readonly account: CliproxyAccount;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow> | undefined;
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onRemove: () => void;
}) {
  const provider =
    (account.driver ? providerClients.get(account.driver)?.label : undefined) ?? account.provider;
  const state =
    account.status === "off"
      ? "Turned off"
      : account.status === "error"
        ? "Error"
        : windows
          ? limitSummary(windows)
          : null;
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          {account.email ? <AccountChip email={account.email} /> : null}
          <span className="truncate">{cliproxyAccountName(account)}</span>
        </span>
      }
      description={[provider, account.plan, state].filter(Boolean).join(" · ")}
      status={
        account.statusMessage ? (
          <p className="text-sm break-words text-destructive">{account.statusMessage}</p>
        ) : undefined
      }
      control={
        canManage ? (
          <div className="flex items-center justify-end gap-2">
            <Button size="xs" variant="outline" disabled={busy} onClick={onToggle}>
              {account.status === "off" ? "Turn on" : "Turn off"}
            </Button>
            <Button size="xs" variant="destructive-outline" disabled={busy} onClick={onRemove}>
              Remove
            </Button>
          </div>
        ) : undefined
      }
    />
  );
}
