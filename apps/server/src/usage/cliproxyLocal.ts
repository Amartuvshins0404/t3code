import { CliproxyLocalError, type CliproxyLocalFailureReason } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const FORMULA = "cliproxyapi";
const DEFAULT_PORT = 8317;
const HOMEBREW_LOCATIONS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
const SECRET_BLOCKS = ["management", "remote-management"] as const;

export interface CliproxyMachine {
  readonly url: string;
  readonly brew: string | null;
  readonly installed: boolean;
  readonly configPath: string | null;
  readonly secretKeySet: boolean;
}

export interface CliproxyFormulaVersion {
  readonly installed: string | null;
  readonly latest: string | null;
  readonly outdated: boolean;
}

const decodeFormulaInfo = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      formulae: Schema.Array(
        Schema.Struct({
          versions: Schema.Struct({ stable: Schema.NullOr(Schema.String) }),
          linked_keg: Schema.NullOr(Schema.String),
          outdated: Schema.Boolean,
        }),
      ),
    }),
  ),
);

const scalarValue = (raw: string) => {
  const text = raw.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1);
    return end === -1 ? text.slice(1) : text.slice(1, end);
  }
  const value = text.replace(/(^|\s+)#.*$/, "").trim();
  return value === "~" || value === "null" ? "" : value;
};

const isComment = (line: string) => line.trim() === "" || line.trim().startsWith("#");

const blockStart = (lines: ReadonlyArray<string>, block: string) =>
  lines.findIndex((line) => new RegExp(`^${block}:\\s*(#.*)?$`).test(line));

const childIndent = (lines: ReadonlyArray<string>, start: number) => {
  const first = lines.slice(start + 1).find((line) => !isComment(line));
  const indent = first === undefined ? "" : /^\s*/.exec(first)![0];
  return indent === "" ? undefined : indent;
};

const blockScalar = (lines: ReadonlyArray<string>, block: string, key: string) => {
  const start = blockStart(lines, block);
  if (start === -1) return undefined;
  const indent = childIndent(lines, start);
  if (indent === undefined) return undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isComment(line)) continue;
    if (!line.startsWith(indent)) return undefined;
    const match = new RegExp(`^${indent}${key}:(\\s.*)?$`).exec(line);
    if (match) return { index, indent, value: scalarValue(match[1] ?? "") };
  }
  return undefined;
};

const secretScalar = (lines: ReadonlyArray<string>) =>
  SECRET_BLOCKS.map((block) => blockScalar(lines, block, "secret-key")).find(
    (scalar) => scalar !== undefined,
  );

const configPort = (text: string) => {
  const lines = text.split("\n");
  const legacy = lines.map((line) => /^port:(\s.*)?$/.exec(line)).find((match) => match !== null);
  const raw = blockScalar(lines, "server", "port")?.value ?? scalarValue(legacy?.[1] ?? "");
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT;
};

const withSecretKey = (text: string, key: string) => {
  const lines = text.split("\n");
  const inline = lines.some(
    (line) => /^(remote-)?management:/.test(line) && !/^(remote-)?management:\s*(#.*)?$/.test(line),
  );
  if (inline) return undefined;
  const value = `secret-key: "${key}"`;
  const existing = secretScalar(lines);
  if (existing) {
    lines[existing.index] = `${existing.indent}${value}`;
    return lines.join("\n");
  }
  const start = SECRET_BLOCKS.map((block) => blockStart(lines, block)).find(
    (index) => index !== -1,
  );
  if (start !== undefined) {
    lines.splice(start + 1, 0, `${childIndent(lines, start) ?? "  "}${value}`);
    return lines.join("\n");
  }
  return `${text.replace(/\n*$/, "\n")}remote-management:\n  ${value}\n`;
};

const withLocalHost = (text: string) => {
  const value = 'host: "127.0.0.1"';
  const lines = text.split("\n");
  const index = lines.findIndex((line) => /^host:(\s.*)?$/.test(line));
  if (index === -1) return `${value}\n${text}`;
  lines[index] = value;
  return lines.join("\n");
};

export const makeCliproxyLocal = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const resolveCommand = (command: string) =>
    resolveCommandPath(command).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const exists = (file: string) => fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));

  const locateBrew = Effect.fn("CliproxyLocal.locateBrew")(function* () {
    if ((yield* HostProcess.Platform) !== "darwin") return null;
    const onPath = yield* resolveCommand("brew");
    if (onPath !== null) return onPath;
    for (const candidate of HOMEBREW_LOCATIONS) {
      if (yield* exists(candidate)) return candidate;
    }
    return null;
  });

  const brewPrefix = Effect.fn("CliproxyLocal.brewPrefix")(function* (brew: string) {
    const output = yield* runner
      .run({ command: brew, args: ["--prefix"], timeout: Duration.seconds(15) })
      .pipe(Effect.option);
    const prefix =
      Option.isSome(output) && output.value.code === 0 ? output.value.stdout.trim() : "";
    return prefix === "" ? null : prefix;
  });

  const detect = Effect.fn("CliproxyLocal.detect")(function* () {
    const brew = yield* locateBrew();
    const prefix = brew === null ? null : yield* brewPrefix(brew);
    const formulaInstalled =
      prefix !== null && (yield* exists(path.join(prefix, "opt", FORMULA, "bin", FORMULA)));
    const installed = formulaInstalled || (yield* resolveCommand(FORMULA)) !== null;
    const configFile = prefix === null ? null : path.join(prefix, "etc", "cliproxyapi.conf");
    const text =
      formulaInstalled && configFile !== null
        ? yield* fileSystem.readFileString(configFile).pipe(Effect.option)
        : Option.none<string>();
    const port = Option.isSome(text) ? configPort(text.value) : DEFAULT_PORT;
    return {
      url: `http://127.0.0.1:${port}`,
      brew,
      installed,
      configPath: Option.isSome(text) ? configFile : null,
      secretKeySet:
        Option.isSome(text) && (secretScalar(text.value.split("\n"))?.value ?? "") !== "",
    } satisfies CliproxyMachine;
  });

  const runBrew = Effect.fn("CliproxyLocal.runBrew")(function* (
    brew: string,
    args: ReadonlyArray<string>,
    timeout: Duration.Input,
    reason: CliproxyLocalFailureReason,
  ) {
    const output = yield* runner
      .run({ command: brew, args, timeout, outputMode: "truncate", maxOutputBytes: 256 * 1024 })
      .pipe(
        Effect.tapError((error) =>
          Effect.logInfo("cliproxy brew step failed", { step: args[0], tag: error._tag }),
        ),
        Effect.mapError(() => new CliproxyLocalError({ reason })),
      );
    if (output.code === 0) return;
    yield* Effect.logInfo("cliproxy brew step failed", { step: args[0], exitCode: output.code });
    return yield* new CliproxyLocalError({ reason });
  });

  const install = (brew: string) =>
    runBrew(brew, ["install", FORMULA], Duration.minutes(20), "installFailed");

  const upgrade = (brew: string) =>
    runBrew(brew, ["upgrade", FORMULA], Duration.minutes(20), "updateFailed");

  const startService = (brew: string) =>
    runBrew(brew, ["services", "restart", FORMULA], Duration.minutes(1), "serviceDidNotStart");

  const version = Effect.fn("CliproxyLocal.version")(function* () {
    const brew = yield* locateBrew();
    const unknown = { installed: null, latest: null, outdated: false };
    if (brew === null) return unknown satisfies CliproxyFormulaVersion;
    const output = yield* runner
      .run({
        command: brew,
        args: ["info", "--json=v2", FORMULA],
        timeout: Duration.seconds(30),
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(Effect.option);
    const formula =
      Option.isSome(output) && output.value.code === 0
        ? Option.flatMap(decodeFormulaInfo(output.value.stdout), (info) =>
            Option.fromNullishOr(info.formulae[0]),
          )
        : Option.none();
    if (Option.isNone(formula)) return unknown satisfies CliproxyFormulaVersion;
    const installed = formula.value.linked_keg?.trim() || null;
    return {
      installed,
      latest: formula.value.versions.stable?.trim() || null,
      outdated: installed !== null && formula.value.outdated,
    } satisfies CliproxyFormulaVersion;
  });

  const writeSecretKey = Effect.fn("CliproxyLocal.writeSecretKey")(function* (
    configPath: string,
    key: string,
    localOnly: boolean,
  ) {
    const notWritable = () => new CliproxyLocalError({ reason: "configNotWritable" });
    const text = yield* fileSystem.readFileString(configPath).pipe(Effect.mapError(notWritable));
    const keyed = withSecretKey(text, key);
    if (keyed === undefined) return yield* notWritable();
    const next = localOnly ? withLocalHost(keyed) : keyed;
    const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
    yield* fileSystem
      .copyFile(configPath, `${configPath}.backup-${stamp}`)
      .pipe(Effect.mapError(notWritable));
    yield* fileSystem.writeFileString(configPath, next).pipe(Effect.mapError(notWritable));
  });

  return { detect, install, upgrade, startService, version, writeSecretKey };
});
