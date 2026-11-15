import * as Aead from "effect/crypto/Aead";
import * as Kdf from "effect/crypto/Kdf";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export class TeamConnectivityLockError extends Schema.TaggedError<TeamConnectivityLockError>()(
  "TeamConnectivityLockError",
  {
    operation: Schema.Literals(["derive", "seal", "open"]),
  },
) {
  override get message(): string {
    return `Team connectivity key could not be processed during '${this.operation}'`;
  }
}

export interface TeamConnectivityLock {
  readonly seal: (input: {
    readonly organizationId: string;
    readonly clientKey: Redacted.Redacted<string>;
  }) => Effect.Effect<string, TeamConnectivityLockError>;
  readonly open: (input: {
    readonly organizationId: string;
    readonly sealed: string;
  }) => Effect.Effect<Redacted.Redacted<string>, TeamConnectivityLockError>;
}

const SEALED_PREFIX = "v1";
const NONCE_LENGTH = Aead.aes256Gcm.nonceLength;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const HKDF_SALT = textEncoder.encode("t3code-relay");
const HKDF_INFO = textEncoder.encode("t3code-relay/team-connectivity/aes-256-gcm/v1");

const additionalData = (organizationId: string) =>
  textEncoder.encode(`relay_team_connectivity:${organizationId}`);

const lockError = (operation: TeamConnectivityLockError["operation"]) => () =>
  new TeamConnectivityLockError({ operation });

export const makeTeamConnectivityLock = Effect.fn("relay.team_connectivity.make_lock")(function* (
  signingPrivateKey: Redacted.Redacted<string>,
) {
  const kdf = yield* Kdf.Kdf;
  const aead = yield* Aead.Aead;
  const random = yield* SecureRandom.SecureRandom;
  const secret = textEncoder.encode(
    Redacted.value(signingPrivateKey).replace(/\\n/gu, "\n").trim(),
  );
  const key = yield* kdf
    .derive(Kdf.hkdfSha256, secret, {
      salt: HKDF_SALT,
      info: HKDF_INFO,
      length: Aead.aes256Gcm.keyLength,
    })
    .pipe(
      Effect.flatMap((bytes) => Aead.key(Aead.aes256Gcm, bytes)),
      Effect.mapError(lockError("derive")),
    );

  const lock: TeamConnectivityLock = {
    seal: Effect.fnUntraced(function* (input) {
      const nonce = yield* random.randomBytes(NONCE_LENGTH);
      const ciphertext = yield* aead
        .encrypt(key, textEncoder.encode(Redacted.value(input.clientKey)), {
          nonce,
          aad: additionalData(input.organizationId),
        })
        .pipe(Effect.mapError(lockError("seal")));
      return [SEALED_PREFIX, Base64Url.encode(nonce), Base64Url.encode(ciphertext)].join(".");
    }),
    open: Effect.fnUntraced(function* (input) {
      const [prefix, encodedNonce, encodedCiphertext, ...rest] = input.sealed.split(".");
      if (prefix !== SEALED_PREFIX || !encodedNonce || !encodedCiphertext || rest.length > 0) {
        return yield* lockError("open")();
      }
      const nonce = Base64Url.decode(encodedNonce);
      const ciphertext = Base64Url.decode(encodedCiphertext);
      if (Result.isFailure(nonce) || Result.isFailure(ciphertext)) {
        return yield* lockError("open")();
      }
      if (nonce.success.length !== NONCE_LENGTH) {
        return yield* lockError("open")();
      }
      const plaintext = yield* aead
        .decrypt(key, ciphertext.success, {
          nonce: nonce.success,
          aad: additionalData(input.organizationId),
        })
        .pipe(Effect.mapError(lockError("open")));
      return yield* Effect.try({
        try: () => Redacted.make(textDecoder.decode(plaintext)),
        catch: lockError("open"),
      });
    }),
  };
  return lock;
});
