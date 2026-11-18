import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

// T3 unsubscribes only when it unloads a thread; Codex's own unload delay would stack on that.
export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  "-c",
  "thread_unload_delay_secs=0",
  ...codexLaunchArgv(launchArgs),
];

export const codexLaunchArgConfigValue = (
  launchArgs: string | undefined,
  key: string,
): string | undefined => {
  const args = codexLaunchArgv(launchArgs);
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const inline = ["--config=", "-c="].find((prefix) => arg.startsWith(prefix));
    const override =
      inline !== undefined
        ? arg.slice(inline.length)
        : arg === "-c" || arg === "--config"
          ? args[++index]
          : undefined;
    const separator = override?.indexOf("=") ?? -1;
    if (override === undefined || separator < 0 || override.slice(0, separator).trim() !== key) {
      continue;
    }
    const match = override.slice(separator + 1).match(/^\s*["']?([^"']+)["']?\s*$/);
    if (match?.[1] !== undefined) value = match[1];
  }
  return value;
};

export const codexLaunchArgModelProvider = (launchArgs?: string): string | undefined =>
  codexLaunchArgConfigValue(launchArgs, "model_provider");

interface LaunchArgFilter {
  readonly switches: ReadonlySet<string>;
  readonly valueFlags: ReadonlySet<string>;
  readonly inlinePrefixes: ReadonlyArray<string>;
}

const SHARED_VALUE_FLAGS = ["--config", "-c", "--enable", "--disable"];
const SHARED_INLINE_PREFIXES = ["--config=", "-c=", "--enable=", "--disable="];

const MCP_LIST_FILTER: LaunchArgFilter = {
  switches: new Set(),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--profile=", "-p="],
};

const EXEC_FILTER: LaunchArgFilter = {
  switches: new Set(["--strict-config", "--oss"]),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--local-provider", "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--local-provider=", "--profile=", "-p="],
};

const filterLaunchArgs = (launchArgs: string | undefined, allowed: LaunchArgFilter) => {
  const args = codexLaunchArgv(launchArgs);
  const kept: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (allowed.switches.has(arg)) {
      kept.push(arg);
    } else if (allowed.valueFlags.has(arg)) {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        kept.push(arg, value);
        index++;
      }
    } else if (allowed.inlinePrefixes.some((prefix) => arg.startsWith(prefix))) {
      kept.push(arg);
    }
  }

  return kept;
};

const HOOK_FEATURES = new Set(["hooks", "codex_hooks"]);

// Feature toggles beat config overrides, so a launch arg's hook enable would undo ours.
export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = filterLaunchArgs(launchArgs, EXEC_FILTER);
  return args.filter((arg, index) => {
    if (arg.startsWith("--enable=")) return !HOOK_FEATURES.has(arg.slice("--enable=".length));
    if (arg === "--enable") return !HOOK_FEATURES.has(args[index + 1] ?? "");
    return !(args[index - 1] === "--enable" && HOOK_FEATURES.has(arg));
  });
};

export const codexMcpListLaunchArgs = (launchArgs?: string) =>
  filterLaunchArgs(launchArgs, MCP_LIST_FILTER);
