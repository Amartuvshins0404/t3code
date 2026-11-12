import {
  CODE_SEARCH_INSTALL_COMMAND,
  CodeSearchProviderId,
  CodeSearchSetupError,
  type CodeSearchConnectInput,
  type CodeSearchConnectResult,
  type CodeSearchFailureReason,
  type CodeSearchStatus,
  type CodeSearchStep,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const MINIMUM_NODE_MAJOR = 22;
const INSTALL_ARGS = CODE_SEARCH_INSTALL_COMMAND.split(" ").slice(1);

const decodeCredentialsProvider = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ provider: CodeSearchProviderId })),
);

const PERMISSION_PATTERN = /\b(EACCES|EPERM)\b|permission denied/i;
const NETWORK_PATTERN =
  /\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\b|fetch failed|network/i;
const REJECTED_PATTERN = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[^\n]{0,20}key/i;

const classifyOutput = (
  output: ProcessRunner.ProcessRunOutput,
  patterns: ReadonlyArray<readonly [RegExp, CodeSearchFailureReason]>,
): CodeSearchFailureReason => {
  const text = `${output.stderr}\n${output.stdout}`;
  return patterns.find(([pattern]) => pattern.test(text))?.[1] ?? "failed";
};

export class CodeSearchSetup extends Context.Service<
  CodeSearchSetup,
  {
    readonly status: Effect.Effect<CodeSearchStatus>;
    readonly connect: (
      input: CodeSearchConnectInput,
    ) => Effect.Effect<CodeSearchConnectResult, CodeSearchSetupError>;
  }
>()("t3/codeSearch/CodeSearchSetup") {}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const resolveCommand = (command: string) =>
    resolveCommandPath(command).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const runStep = (
    step: CodeSearchStep,
    input: ProcessRunner.ProcessRunInput,
    patterns: ReadonlyArray<readonly [RegExp, CodeSearchFailureReason]>,
  ) =>
    runner.run({ ...input, outputMode: "truncate", maxOutputBytes: 256 * 1024 }).pipe(
      Effect.tapError((error) =>
        Effect.logInfo("code search step failed", { step, tag: error._tag }),
      ),
      Effect.mapError(
        (error) =>
          new CodeSearchSetupError({
            step,
            reason: error._tag === "ProcessTimeoutError" ? "timed_out" : "failed",
          }),
      ),
      Effect.flatMap((output) => {
        if (output.code === 0) return Effect.void;
        const reason = classifyOutput(output, patterns);
        return Effect.logInfo("code search step failed", {
          step,
          exitCode: output.code,
          reason,
        }).pipe(Effect.andThen(Effect.fail(new CodeSearchSetupError({ step, reason }))));
      }),
    );

  const npmGlobalExecutable = Effect.fn("CodeSearchSetup.npmGlobalExecutable")(function* () {
    const npm = yield* resolveCommand("npm");
    if (npm === null) return null;
    const output = yield* runner
      .run({ command: npm, args: ["prefix", "-g"], timeout: Duration.seconds(15) })
      .pipe(Effect.option);
    const prefix =
      Option.isSome(output) && output.value.code === 0 ? output.value.stdout.trim() : "";
    if (prefix === "") return null;
    const platform = yield* HostProcess.Platform;
    const candidate =
      platform === "win32" ? path.join(prefix, "jg.cmd") : path.join(prefix, "bin", "jg");
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    return exists ? candidate : null;
  });

  const locate = Effect.fn("CodeSearchSetup.locate")(function* () {
    const onPath = yield* resolveCommand("jg");
    return onPath ?? (yield* npmGlobalExecutable());
  });

  const credentialsPath = Effect.fn("CodeSearchSetup.credentialsPath")(function* () {
    const env = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    const xdg = env.XDG_CONFIG_HOME?.trim();
    const appData = env.APPDATA?.trim();
    const configDir =
      xdg && path.isAbsolute(xdg)
        ? path.join(xdg, "jevgrep")
        : platform === "win32" && appData
          ? path.join(appData, "jevgrep")
          : path.join(yield* HostProcess.HomeDirectory, ".config", "jevgrep");
    return path.join(configDir, "credentials.json");
  });

  const readProvider = Effect.fn("CodeSearchSetup.readProvider")(function* () {
    const file = yield* credentialsPath();
    const text = yield* fileSystem.readFileString(file).pipe(Effect.option);
    return Option.isSome(text)
      ? Option.getOrUndefined(decodeCredentialsProvider(text.value))?.provider
      : undefined;
  });

  const readVersion = Effect.fn("CodeSearchSetup.readVersion")(function* (executable: string) {
    const output = yield* runner
      .run({ command: executable, args: ["--version"], timeout: Duration.seconds(15) })
      .pipe(Effect.option);
    if (Option.isNone(output) || output.value.code !== 0) return undefined;
    const version = output.value.stdout.trim().split(/\r?\n/)[0]?.trim().slice(0, 64);
    return version === "" ? undefined : version;
  });

  const status = Effect.gen(function* () {
    const executable = yield* locate();
    const provider = yield* readProvider();
    const version = executable === null ? undefined : yield* readVersion(executable);
    return {
      installed: executable !== null,
      ...(version === undefined ? {} : { version }),
      ...(provider === undefined ? {} : { provider }),
    } satisfies CodeSearchStatus;
  }).pipe(Effect.withSpan("CodeSearchSetup.status"));

  const checkNode = Effect.fn("CodeSearchSetup.checkNode")(function* () {
    const node = yield* resolveCommand("node");
    if (node === null) return;
    const output = yield* runner
      .run({ command: node, args: ["--version"], timeout: Duration.seconds(15) })
      .pipe(Effect.option);
    if (Option.isNone(output) || output.value.code !== 0) return;
    const major = Number(/^v?(\d+)\./.exec(output.value.stdout.trim())?.[1]);
    if (Number.isFinite(major) && major < MINIMUM_NODE_MAJOR) {
      return yield* new CodeSearchSetupError({ step: "install", reason: "node_too_old" });
    }
  });

  const install = Effect.fn("CodeSearchSetup.install")(function* () {
    const existing = yield* locate();
    if (existing !== null) return existing;
    const npm = yield* resolveCommand("npm");
    if (npm === null) {
      return yield* new CodeSearchSetupError({ step: "install", reason: "npm_missing" });
    }
    yield* checkNode();
    yield* runStep("install", { command: npm, args: INSTALL_ARGS, timeout: Duration.minutes(5) }, [
      [PERMISSION_PATTERN, "permission_denied"],
      [NETWORK_PATTERN, "network"],
    ]);
    const installed = yield* locate();
    if (installed === null) {
      return yield* new CodeSearchSetupError({
        step: "install",
        reason: "not_found_after_install",
      });
    }
    return installed;
  });

  const connect = Effect.fn("CodeSearchSetup.connect")(function* (input: CodeSearchConnectInput) {
    const jg = yield* install();
    yield* runStep(
      "auth",
      {
        command: jg,
        args: ["auth", "--provider", input.provider, "--stdin"],
        stdin: input.apiKey,
        timeout: Duration.seconds(30),
      },
      [[PERMISSION_PATTERN, "permission_denied"]],
    );
    yield* runStep("test", { command: jg, args: ["doctor"], timeout: Duration.seconds(60) }, [
      [REJECTED_PATTERN, "rejected"],
      [NETWORK_PATTERN, "network"],
    ]);
    yield* runStep(
      "skill",
      { command: jg, args: ["skill", "--global", "--yes"], timeout: Duration.minutes(2) },
      [
        [PERMISSION_PATTERN, "permission_denied"],
        [NETWORK_PATTERN, "network"],
      ],
    );
    return {
      status: yield* status,
      passed: ["install", "auth", "test", "skill"],
    } satisfies CodeSearchConnectResult;
  });

  return CodeSearchSetup.of({ status, connect });
});

export const layer = Layer.effect(CodeSearchSetup, make);
