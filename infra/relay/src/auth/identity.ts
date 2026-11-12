import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Signature from "effect/crypto/Signature";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Jwks from "effect/jose/Jwks";
import * as Jwt from "effect/jose/Jwt";

import * as RelayConfiguration from "../Config.ts";

export const IdentityOrganization = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  role: Schema.String,
});
export type IdentityOrganization = typeof IdentityOrganization.Type;

const IdentityClaims = Schema.Struct({
  sub: Schema.NonEmptyString,
  email: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  orgs: Schema.optionalKey(Schema.Array(IdentityOrganization)),
});

export interface VerifiedIdentity {
  readonly userId: string;
  readonly email: string | undefined;
  readonly name: string | undefined;
  readonly orgs: ReadonlyArray<IdentityOrganization>;
}

export class IdentityTokenRejected extends Schema.TaggedError<IdentityTokenRejected>()(
  "IdentityTokenRejected",
  {
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Identity token rejected: ${this.reason}`;
  }
}

export class Identity extends Context.Service<
  Identity,
  {
    readonly verify: (token: string) => Effect.Effect<VerifiedIdentity, IdentityTokenRejected>;
  }
>()("t3code-relay/auth/identity") {}

function rejectionReason(error: Jwt.JwtError): string {
  if (error._tag === "SchemaError") return "invalid_claims";
  const reason = error.reason as { readonly _tag?: unknown };
  return typeof reason._tag === "string" ? reason._tag : "unknown";
}

export const make = Effect.fnUntraced(function* (settings: RelayConfiguration.IdentitySettings) {
  const context = yield* Effect.context<Jwks.Jwks | Signature.Signature>();
  return Identity.of({
    verify: Effect.fn("relay.identity.verify")(function* (token) {
      yield* Effect.annotateCurrentSpan({ "relay.auth.token_length": token.length });
      const verified = yield* Jwt.verifyWithKeySet(IdentityClaims, token, {
        algorithms: ["EdDSA"],
        issuer: settings.issuer,
        audience: settings.audience,
        requiredClaims: ["exp"],
      }).pipe(
        Effect.provideContext(context),
        Effect.mapError(
          (cause) => new IdentityTokenRejected({ reason: rejectionReason(cause), cause }),
        ),
      );
      const { claims } = verified;
      return {
        userId: claims.sub,
        email: claims.email,
        name: claims.name ?? undefined,
        orgs: claims.orgs ?? [],
      };
    }),
  });
});

export const layerWithJwks = (settings: RelayConfiguration.IdentitySettings) =>
  Layer.effect(Identity, make(settings));

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { identity } = yield* RelayConfiguration.RelayConfiguration;
    return layerWithJwks(identity).pipe(
      Layer.provide(
        Jwks.layerRemote({ url: identity.jwksUrl }).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
          Layer.orDie,
        ),
      ),
    );
  }),
);
