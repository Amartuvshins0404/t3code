import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readSource } from "./Codemap.ts";

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
