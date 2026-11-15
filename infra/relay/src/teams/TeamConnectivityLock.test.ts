import { describe, expect, it } from "@effect/vitest";
import * as Aead from "effect/crypto/Aead";
import * as Kdf from "effect/crypto/Kdf";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { makeTeamConnectivityLock } from "./TeamConnectivityLock.ts";

const layerCrypto = Layer.mergeAll(Aead.layerWebCrypto, Kdf.layerWebCrypto).pipe(
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);

describe("team connectivity lock", () => {
  it.effect("stores ciphertext that opens only for its own team under the same relay key", () =>
    Effect.gen(function* () {
      const clientKey = "fake-team-key-for-lock-test";
      const lock = yield* makeTeamConnectivityLock(Redacted.make("fake-relay-signing-key"));
      const sealed = yield* lock.seal({
        organizationId: "org-1",
        clientKey: Redacted.make(clientKey),
      });
      expect(sealed).not.toContain(clientKey);
      expect(sealed).not.toContain(Buffer.from(clientKey).toString("base64url"));

      const again = yield* lock.seal({
        organizationId: "org-1",
        clientKey: Redacted.make(clientKey),
      });
      expect(again).not.toBe(sealed);

      const opened = yield* lock.open({ organizationId: "org-1", sealed });
      expect(Redacted.value(opened)).toBe(clientKey);

      const otherTeam = yield* lock.open({ organizationId: "org-2", sealed }).pipe(Effect.flip);
      expect(otherTeam).toMatchObject({ _tag: "TeamConnectivityLockError", operation: "open" });
      expect(otherTeam.message).not.toContain(clientKey);

      const otherRelay = yield* makeTeamConnectivityLock(Redacted.make("another-fake-key"));
      expect(
        yield* otherRelay.open({ organizationId: "org-1", sealed }).pipe(Effect.flip),
      ).toMatchObject({ operation: "open" });
    }).pipe(Effect.provide(layerCrypto)),
  );
});
