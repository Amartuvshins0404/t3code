import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  CODE_SEARCH_INSTALL_COMMAND,
  CODE_SEARCH_PROVIDER_LABELS,
  CodeSearchSetupError,
  ProviderDriverKind,
  type CodeSearchFailureReason,
  type CodeSearchProviderId,
  type CodeSearchStatus,
  type CodeSearchStep,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { CheckIcon, CircleIcon, XIcon } from "lucide-react";
import { useContext, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { codeSearchConnect, codeSearchStatus } from "../state/codeSearch";
import { useAtomCommand } from "../state/use-atom-command";
import { CommandBlock } from "./CommandBlock";
import { ProjectMonogram } from "./ProjectMonogram";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { SecretInput } from "./settings/SecretInput";
import { Button } from "./ui/button";
import { Radio, RadioGroup } from "./ui/radio-group";
import { Spinner } from "./ui/spinner";

const PROVIDERS: ReadonlyArray<CodeSearchProviderId> = [
  "typesafe",
  "openrouter",
  "vercel",
  "opencode",
];

const isSetupError = Schema.is(CodeSearchSetupError);

type CheckId = "installed" | "key" | "agents";

const CHECKS: ReadonlyArray<{ readonly id: CheckId; readonly label: string }> = [
  { id: "installed", label: "Search tool installed" },
  { id: "key", label: "Key works" },
  { id: "agents", label: "Agents know how to use it" },
];

const CHECK_BY_STEP: Record<CodeSearchStep, CheckId> = {
  install: "installed",
  auth: "key",
  test: "key",
  skill: "agents",
};

type ConnectState =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | {
      readonly kind: "failed";
      readonly step: CodeSearchStep | null;
      readonly reason: CodeSearchFailureReason | null;
    };

const statusAtom = (environmentId: EnvironmentId) => codeSearchStatus({ environmentId, input: {} });

export function useCodeSearchStatus(environmentId: EnvironmentId): CodeSearchStatus | null {
  return AsyncResult.getOrElse(useAtomValue(statusAtom(environmentId)), () => null);
}

export function codeSearchStatusLabel(status: CodeSearchStatus | null): string {
  if (status === null) return "Checking…";
  if (status.provider !== undefined) {
    return `Connected through ${CODE_SEARCH_PROVIDER_LABELS[status.provider]}`;
  }
  return status.installed ? "Installed, no key yet" : "Not set up";
}

function VercelMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 3 23 21H1z" />
    </svg>
  );
}

function ProviderLogo({ provider }: { readonly provider: CodeSearchProviderId }) {
  const label = CODE_SEARCH_PROVIDER_LABELS[provider];
  switch (provider) {
    case "typesafe":
      return <ProjectMonogram text="TS" color="blue" className="size-5" />;
    case "vercel":
      return <VercelMark className="size-4 text-foreground" />;
    case "openrouter":
    case "opencode":
      return (
        <ProviderInstanceIcon
          driverKind={ProviderDriverKind.make(provider)}
          displayName={label}
          badgeContent="none"
        />
      );
  }
}

function failureMessage(
  state: Extract<ConnectState, { kind: "failed" }>,
  provider: CodeSearchProviderId | null,
): ReactNode {
  const providerLabel = provider === null ? "the provider" : CODE_SEARCH_PROVIDER_LABELS[provider];
  switch (state.step) {
    case "install":
      switch (state.reason) {
        case "npm_missing":
          return "Install failed: npm isn't on the server's computer. Install Node.js 22 or newer, then try again.";
        case "node_too_old":
          return "Install failed: the search tool needs Node.js 22 or newer on the server's computer.";
        case "permission_denied":
          return "Install failed: npm needs admin rights on the server's computer. Run this there, then press Connect again.";
        case "network":
          return "Install failed: the server couldn't reach npm. Check its internet connection.";
        case "not_found_after_install":
          return "Install finished, but the server can't find jg. Add npm's global folder to PATH, or restart the app.";
        case "timed_out":
          return "Install took too long. Try again.";
        default:
          return "Install failed. Try again.";
      }
    case "auth":
      return "Saving the key failed. Try again.";
    case "test":
      switch (state.reason) {
        case "rejected":
          return `Key check failed: ${providerLabel} turned this key down. Check it and try again.`;
        case "network":
          return `Key check failed: the server couldn't reach ${providerLabel}.`;
        case "timed_out":
          return `Key check failed: ${providerLabel} took too long to answer.`;
        default:
          return "Key check failed. Check the key and try again.";
      }
    case "skill":
      return state.reason === "network"
        ? "The key works, but teaching the agents needs internet on the server. Try again."
        : "The key works, but teaching the agents failed. Try again.";
    case null:
      return "Couldn't connect. Try again.";
  }
}

function checkState(
  check: CheckId,
  state: ConnectState,
  status: CodeSearchStatus | null,
): "done" | "running" | "failed" | "waiting" {
  if (state.kind === "connected") return "done";
  if (state.kind === "failed" && state.step !== null) {
    const failedIndex = CHECKS.findIndex(({ id }) => id === CHECK_BY_STEP[state.step!]);
    const index = CHECKS.findIndex(({ id }) => id === check);
    return index < failedIndex ? "done" : index === failedIndex ? "failed" : "waiting";
  }
  if (check === "installed" && status?.installed) return "done";
  return state.kind === "connecting" ? "running" : "waiting";
}

function CheckRow({
  label,
  state,
}: {
  readonly label: string;
  readonly state: ReturnType<typeof checkState>;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-2 text-xs",
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

export function CodeSearchSetup({
  environmentId,
  onConnect,
}: {
  readonly environmentId: EnvironmentId;
  readonly onConnect?: () => void;
}) {
  const registry = useContext(RegistryContext);
  const status = useCodeSearchStatus(environmentId);
  const canConnect = useAtomValue(codeSearchConnect.permissionAtom(environmentId));
  const connect = useAtomCommand(codeSearchConnect, { reportFailure: false });
  const [picked, setPicked] = useState<CodeSearchProviderId | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [state, setState] = useState<ConnectState>({ kind: "idle" });
  const provider = picked ?? status?.provider ?? null;
  const connecting = state.kind === "connecting";
  const showChecks = state.kind !== "idle";

  const submit = async () => {
    if (provider === null || apiKey.trim() === "") return;
    onConnect?.();
    setState({ kind: "connecting" });
    const result = await connect({
      environmentId,
      input: { provider, apiKey: apiKey.trim() },
    });
    registry.refresh(statusAtom(environmentId));
    if (result._tag === "Success") {
      setApiKey("");
      setState({ kind: "connected" });
      return;
    }
    const error = Cause.squash(result.cause);
    setState(
      isSetupError(error)
        ? { kind: "failed", step: error.step, reason: error.reason }
        : { kind: "failed", step: null, reason: null },
    );
  };

  return (
    <div className="flex flex-col gap-3 py-2">
      <RadioGroup
        aria-label="Code search provider"
        className="grid sm:grid-cols-2"
        disabled={connecting || !canConnect}
        value={provider}
        onValueChange={(value) => {
          setPicked(value as CodeSearchProviderId);
          setState({ kind: "idle" });
        }}
      >
        {PROVIDERS.map((id) => (
          <label
            key={id}
            className={cn(
              "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm transition-colors has-data-disabled:cursor-default has-data-disabled:opacity-64",
              provider === id
                ? "border-primary/70 bg-primary/5 ring-1 ring-primary/40"
                : "border-border hover:border-foreground/20",
            )}
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              <ProviderLogo provider={id} />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
              {CODE_SEARCH_PROVIDER_LABELS[id]}
            </span>
            <Radio value={id} />
          </label>
        ))}
      </RadioGroup>
      {provider !== null ? (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <SecretInput
            className="min-w-0 sm:flex-1"
            aria-label={`${CODE_SEARCH_PROVIDER_LABELS[provider]} API key`}
            placeholder={`${CODE_SEARCH_PROVIDER_LABELS[provider]} API key`}
            disabled={connecting || !canConnect}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            disabled={connecting || !canConnect || apiKey.trim() === ""}
          >
            {connecting ? <Spinner /> : null}
            {connecting ? "Connecting…" : status?.provider === undefined ? "Connect" : "Reconnect"}
          </Button>
        </form>
      ) : null}
      {showChecks ? (
        <ul className="flex flex-col gap-1.5">
          {CHECKS.map((check) => (
            <CheckRow
              key={check.id}
              label={check.label}
              state={checkState(check.id, state, status)}
            />
          ))}
        </ul>
      ) : null}
      {state.kind === "failed" ? (
        <div className="flex flex-col gap-2" role="alert">
          <p className="text-xs text-destructive">{failureMessage(state, provider)}</p>
          {state.step === "install" && state.reason === "permission_denied" ? (
            <CommandBlock command={CODE_SEARCH_INSTALL_COMMAND} />
          ) : null}
        </div>
      ) : null}
      {!canConnect ? (
        <p className="text-xs text-muted-foreground">
          Only someone who can change this server's settings can connect code search.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Searches send the code they read to the provider you pick.
      </p>
    </div>
  );
}
