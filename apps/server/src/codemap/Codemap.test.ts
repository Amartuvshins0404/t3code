import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readSource } from "./Codemap.ts";

it.layer(NodeServices.layer)("readSource", (it) => {
  it.effect("reads small regular files and skips links, devices and huge files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codemap-read-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codemap-outside-" });
      yield* fs.writeFileString(path.join(root, "ok.ts"), "a\nb");
      yield* fs.writeFileString(path.join(outside, "secret.ts"), "secret");
      yield* fs.writeFileString(path.join(root, "dump.ts"), "x".repeat(2 * 1024 * 1024));
      yield* fs.symlink(path.join(outside, "secret.ts"), path.join(root, "escape.ts"));
      yield* fs.symlink("/dev/zero", path.join(root, "zero.ts"));

      expect(new TextDecoder().decode((yield* readSource(root, "ok.ts")) ?? undefined)).toBe(
        "a\nb",
      );
      expect(yield* readSource(root, "escape.ts")).toBeNull();
      expect(yield* readSource(root, "zero.ts")).toBeNull();
      expect(yield* readSource(root, "dump.ts")).toBeNull();
    }),
  );
});
