// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointRef, RunId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { type GitRun, readSource, readThreadChanges } from "./Codemap.ts";
import { analyzeCodebase } from "./analyze.ts";

it.layer(NodeServices.layer)("readSource", (it) => {
  it.effect("reads small files inside the repo and skips links, devices and huge files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-codemap-" }));
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codemap-outside-" });
      yield* fs.writeFileString(path.join(root, "ok.ts"), "a\nb");
      yield* fs.writeFileString(path.join(outside, "secret.ts"), "secret");
      yield* fs.writeFileString(path.join(root, "dump.ts"), "x".repeat(2 * 1024 * 1024));
      yield* fs.symlink(path.join(outside, "secret.ts"), path.join(root, "escape.ts"));
      yield* fs.symlink(outside, path.join(root, "linked"));
      yield* fs.symlink("/dev/zero", path.join(root, "zero.ts"));
      const read = (file: string) =>
        readSource(root, file).pipe(
          Effect.map((bytes) => (bytes === null ? null : new TextDecoder().decode(bytes))),
        );

      expect(yield* read("ok.ts")).toBe("a\nb");
      expect(yield* read("escape.ts")).toBeNull();
      expect(yield* read("linked/secret.ts")).toBeNull();
      expect(yield* read("zero.ts")).toBeNull();
      expect(yield* read("dump.ts")).toBeNull();
    }),
  );
});

it.layer(NodeServices.layer)("readThreadChanges", (it) => {
  it.effect(
    "shows a file the thread moved as moved with only its edited lines, even inside a large pull",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-codemap-git-" }),
        );
        const git = (...args: string[]) =>
          NodeChildProcess.execFileSync(
            "git",
            [
              "-c",
              "user.email=t@t",
              "-c",
              "user.name=t",
              "-c",
              "gc.auto=0",
              "-c",
              "maintenance.auto=false",
              ...args,
            ],
            {
              cwd,
              encoding: "utf8",
            },
          );
        yield* fs.makeDirectory(path.join(cwd, "app"));
        yield* fs.writeFileString(
          path.join(cwd, "app/old.ts"),
          Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n") + "\n",
        );
        yield* fs.writeFileString(path.join(cwd, "app/pulled.ts"), "a\n");
        yield* fs.makeDirectory(path.join(cwd, "gone"));
        yield* fs.makeDirectory(path.join(cwd, "arrived"));
        for (let index = 0; index < 1100; index += 1)
          yield* fs.writeFileString(path.join(cwd, "gone", `${index}.ts`), `gone ${index}\n`);
        git("init", "-q");
        git("add", "-A");
        git("commit", "-qm", "base");
        git("mv", "app/old.ts", "app/new.ts");
        git("rm", "-rq", "gone");
        for (let index = 0; index < 1100; index += 1)
          yield* fs.writeFileString(
            path.join(cwd, "arrived", `${index}.ts`),
            `arrived ${index * 7919}\n`,
          );
        yield* fs.writeFileString(
          path.join(cwd, "app/new.ts"),
          Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n") + "\nadded\n",
        );
        yield* fs.writeFileString(path.join(cwd, "app/pulled.ts"), "a\nb\n");
        git("add", "-A");
        git("commit", "-qm", "turn");
        const run: GitRun = (_cwd, _operation, args) =>
          Effect.sync(() => Option.some({ exitCode: 0, stdout: git(...args) }));

        const changes = yield* readThreadChanges(
          run,
          {
            cwd,
            baseline: CheckpointRef.make(git("rev-parse", "HEAD~1").trim()),
            latest: CheckpointRef.make(git("rev-parse", "HEAD").trim()),
            runByPath: new Map([["app/new.ts", RunId.make("run-1")]]),
          },
          "",
          analyzeCodebase({ files: ["app/new.ts"], lineCounts: new Map(), manifests: new Map() }),
        );

        expect(
          changes.map(({ path: file, from, status, additions, deletions }) => [
            file,
            from,
            status,
            additions,
            deletions,
          ]),
        ).toEqual([["app/new.ts", "app/old.ts", "renamed", 1, 0]]);
      }),
  );
});

it.layer(NodeServices.layer)("readThreadChanges on a large move", (it) => {
  it.effect("keeps every moved file paired when its paths need several git calls", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-codemap-move-" }),
      );
      const git = (...args: string[]) =>
        NodeChildProcess.execFileSync(
          "git",
          [
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
            ...args,
          ],
          {
            cwd,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
          },
        );
      const folder = `a-folder-with-a-rather-long-name-${"x".repeat(60)}`;
      const files = Array.from({ length: 300 }, (_, index) => `file-${index}.ts`);
      yield* fs.makeDirectory(path.join(cwd, "old", folder), { recursive: true });
      yield* fs.makeDirectory(path.join(cwd, "pulled"));
      for (const file of files)
        yield* fs.writeFileString(
          path.join(cwd, "old", folder, file),
          `export const n = "${file}";\n`,
        );
      for (let index = 0; index < 50; index += 1)
        yield* fs.writeFileString(path.join(cwd, "pulled", `p${index}.ts`), "a\n");
      git("init", "-q");
      git("add", "-A");
      git("commit", "-qm", "base");
      git("mv", "old", "new");
      for (let index = 0; index < 50; index += 1)
        yield* fs.writeFileString(path.join(cwd, "pulled", `p${index}.ts`), "a\nb\n");
      git("add", "-A");
      git("commit", "-qm", "turn");
      const run: GitRun = (_cwd, _operation, args) =>
        Effect.sync(() => Option.some({ exitCode: 0, stdout: git(...args) }));
      const calls: string[][] = [];
      const counted: GitRun = (cwdArg, operation, args, maxBytes) => {
        calls.push([...args]);
        return run(cwdArg, operation, args, maxBytes);
      };

      const changes = yield* readThreadChanges(
        counted,
        {
          cwd,
          baseline: CheckpointRef.make(git("rev-parse", "HEAD~1").trim()),
          latest: CheckpointRef.make(git("rev-parse", "HEAD").trim()),
          runByPath: new Map(files.map((file) => [`new/${folder}/${file}`, RunId.make("run-1")])),
        },
        "",
        analyzeCodebase({ files: [], lineCounts: new Map(), manifests: new Map() }),
      );

      expect(calls.length).toBeGreaterThan(2);
      expect(changes).toHaveLength(300);
      expect(new Set(changes.map((change) => change.status))).toEqual(new Set(["renamed"]));
      expect(changes.every((change) => change.from === change.path.replace(/^new\//, "old/"))).toBe(
        true,
      );
    }),
  );
});
