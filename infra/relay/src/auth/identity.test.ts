import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Jwks from "effect/jose/Jwks";
import * as Jwt from "effect/jose/Jwt";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as Identity from "./identity.ts";

const NOW_SECONDS = 1_800_000_000;
const settings = {
  issuer: "https://auth.example.test",
  audience: "t3-relay",
  jwksUrl: "https://auth.example.test/api/auth/jwks",
};

const Claims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  email: Schema.String,
  name: Schema.String,
  orgs: Schema.Array(Identity.IdentityOrganization),
  iat: Schema.Number,
  exp: Schema.Number,
});

const layerCrypto = Signature.layerWebCrypto.pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

const verifyWith = (overrides: Partial<typeof Claims.Type>, signer: "trusted" | "untrusted") =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_SECONDS * 1_000);
    const trusted = yield* Jwk.generateKeyPair({ algorithm: "EdDSA", kid: "trusted" });
    const untrusted = yield* Jwk.generateKeyPair({ algorithm: "EdDSA", kid: "trusted" });
    const signingKey = yield* Jwk.importPrivate(
      (signer === "trusted" ? trusted : untrusted).privateKey,
      "EdDSA",
    );
    const token = yield* Jwt.sign(
      Claims,
      {
        iss: settings.issuer,
        aud: settings.audience,
        sub: "user-1",
        email: "owner@example.test",
        name: "Owner",
        orgs: [{ id: "org-1", slug: "home", role: "owner" }],
        iat: NOW_SECONDS - 60,
        exp: NOW_SECONDS + 900,
        ...overrides,
      },
      signingKey,
      { kid: "trusted" },
    );
    const identity = yield* Identity.Identity.pipe(
      Effect.provide(
        Identity.layerWithJwks(settings).pipe(
          Layer.provide(Jwks.layerLocal({ keys: [trusted.publicKey] })),
        ),
      ),
    );
    return yield* identity.verify(Redacted.value(token)).pipe(Effect.result);
  }).pipe(Effect.provide(layerCrypto));

describe("Identity", () => {
  it.effect("accepts a token signed by the issuer's key and returns its claims", () =>
    Effect.gen(function* () {
      const result = yield* verifyWith({}, "trusted");
      expect(result).toMatchObject({
        _tag: "Success",
        success: {
          userId: "user-1",
          email: "owner@example.test",
          name: "Owner",
          orgs: [{ id: "org-1", slug: "home", role: "owner" }],
        },
      });
    }),
  );

  it.effect("rejects a wrong audience, a wrong issuer, an expired token and a foreign key", () =>
    Effect.gen(function* () {
      const cases = [
        yield* verifyWith({ aud: "someone-else" }, "trusted"),
        yield* verifyWith({ iss: "https://evil.example.test" }, "trusted"),
        yield* verifyWith({ iat: NOW_SECONDS - 3_600, exp: NOW_SECONDS - 60 }, "trusted"),
        yield* verifyWith({}, "untrusted"),
      ];
      for (const result of cases) {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "IdentityTokenRejected" },
        });
      }
    }),
  );
});
