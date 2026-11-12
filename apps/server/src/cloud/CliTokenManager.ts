import {
  type CloudAuth,
  type CloudDeviceVerification,
  CloudAuthError,
  type CloudSessionStore,
  CloudStoredSession,
  createCloudAuth,
  isCloudAuthError,
} from "@t3tools/client-runtime/cloud-auth";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import { authUrlConfig } from "./publicConfig.ts";

const CLOUD_CLI_SESSION_SECRET = "cloud-cli-session";

const StoredSessionJson = Schema.fromJsonString(CloudStoredSession);
const decodeStoredSession = Schema.decodeUnknownOption(StoredSessionJson);
const encodeStoredSession = Schema.encodeSync(StoredSessionJson);

export interface CloudCliCredential {
  readonly accessToken: string;
  readonly identity?: string;
}

export interface DeviceAuthorizationPrompt {
  readonly verificationUri: string;
  readonly verificationUriComplete: string | undefined;
  readonly userCode: string;
  readonly expiresIn: Duration.Duration;
}

export class CloudCliCredentialRemovalError extends Schema.TaggedError<CloudCliCredentialRemovalError>()(
  "CloudCliCredentialRemovalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not remove the stored T3 Connect CLI credential.";
  }
}

export class CloudCliCredentialRefreshError extends Schema.TaggedError<CloudCliCredentialRefreshError>()(
  "CloudCliCredentialRefreshError",
  {
    cause: Schema.Defect(),
    status: Schema.optional(Schema.Number),
  },
) {
  get requiresLogin(): boolean {
    return this.status === 401;
  }

  override get message(): string {
    return this.requiresLogin
      ? "The T3 Connect CLI sign-in expired. Run `t3 connect login` to authorize again."
      : "Could not refresh the T3 Connect CLI credential.";
  }
}

export const isCloudCliCredentialRefreshError = Schema.is(CloudCliCredentialRefreshError);

export class CloudCliCredentialReadError extends Schema.TaggedError<CloudCliCredentialReadError>()(
  "CloudCliCredentialReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the stored T3 Connect CLI credential.";
  }
}

export class CloudCliAuthorizationError extends Schema.TaggedError<CloudCliAuthorizationError>()(
  "CloudCliAuthorizationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not authorize the T3 Connect CLI.";
  }
}

export class CloudCliAuthorizationTimeoutError extends Schema.TaggedError<CloudCliAuthorizationTimeoutError>()(
  "CloudCliAuthorizationTimeoutError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Timed out waiting for T3 Connect authorization.";
  }
}

export class CloudCliAuthorizationDeniedError extends Schema.TaggedError<CloudCliAuthorizationDeniedError>()(
  "CloudCliAuthorizationDeniedError",
  {},
) {
  override get message(): string {
    return "T3 Connect authorization was denied in the browser.";
  }
}

export const CloudCliTokenManagerError = Schema.Union([
  CloudCliCredentialRemovalError,
  CloudCliCredentialRefreshError,
  CloudCliCredentialReadError,
  CloudCliAuthorizationError,
  CloudCliAuthorizationTimeoutError,
  CloudCliAuthorizationDeniedError,
]);
export type CloudCliTokenManagerError = typeof CloudCliTokenManagerError.Type;

export class CloudCliTokenManager extends Context.Service<
  CloudCliTokenManager,
  {
    readonly getExisting: Effect.Effect<
      Option.Option<CloudCliCredential>,
      CloudCliTokenManagerError
    >;
    readonly hasCredential: Effect.Effect<boolean, CloudCliTokenManagerError>;
    readonly login: <E, R>(input: {
      readonly showPrompt: (prompt: DeviceAuthorizationPrompt) => Effect.Effect<void, E, R>;
      readonly openBrowser: boolean;
    }) => Effect.Effect<CloudCliCredential, CloudCliTokenManagerError, R>;
    readonly clear: Effect.Effect<void, CloudCliTokenManagerError>;
  }
>()("t3/cloud/CliTokenManager/CloudCliTokenManager") {}

function authorizationError(cause: unknown): CloudCliTokenManagerError {
  if (!isCloudAuthError(cause)) return new CloudCliAuthorizationError({ cause });
  switch (cause.reason) {
    case "denied":
      return new CloudCliAuthorizationDeniedError();
    case "expired":
      return new CloudCliAuthorizationTimeoutError({ cause });
    default:
      return new CloudCliAuthorizationError({ cause });
  }
}

function toPrompt(verification: CloudDeviceVerification, now: number): DeviceAuthorizationPrompt {
  return {
    verificationUri: verification.verificationUri,
    verificationUriComplete: verification.verificationUriComplete,
    userCode: verification.userCode,
    expiresIn: Duration.millis(Math.max(0, verification.expiresAtMillis - now)),
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
  const semaphore = yield* Semaphore.make(1);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  let prompt: ((verification: CloudDeviceVerification) => Promise<void>) | null = null;

  const store: CloudSessionStore = {
    read: () =>
      runPromise(
        secrets
          .get(CLOUD_CLI_SESSION_SECRET)
          .pipe(
            Effect.map((bytes) =>
              Option.getOrNull(
                Option.flatMap(bytes, (value) =>
                  decodeStoredSession(new TextDecoder().decode(value)),
                ),
              ),
            ),
          ),
      ),
    write: (session) =>
      runPromise(
        session
          ? secrets.set(
              CLOUD_CLI_SESSION_SECRET,
              new TextEncoder().encode(encodeStoredSession(session)),
            )
          : secrets.remove(CLOUD_CLI_SESSION_SECRET),
      ),
  };

  const auth = yield* Effect.cached(
    Effect.gen(function* () {
      const authUrl = yield* authUrlConfig;
      return createCloudAuth({
        authUrl,
        platform: {
          store,
          signIn: (_method, context) =>
            prompt
              ? context.signInWithDevice(prompt)
              : Promise.reject(
                  new CloudAuthError({ reason: "failed", detail: "No sign-in prompt." }),
                ),
        },
      });
    }).pipe(Effect.mapError((cause) => new CloudCliCredentialReadError({ cause }))),
  );

  const credential = (cloudAuth: CloudAuth, accessToken: string): CloudCliCredential => {
    const state = cloudAuth.getState();
    return state.status === "signedIn"
      ? { accessToken, identity: state.user.email || state.user.name }
      : { accessToken };
  };

  const getExisting = Effect.gen(function* () {
    const cloudAuth = yield* auth;
    const token = yield* Effect.tryPromise({
      try: () => cloudAuth.getRelayIdentityToken(),
      catch: (cause) => new CloudCliCredentialRefreshError({ cause }),
    });
    return token === null ? Option.none() : Option.some(credential(cloudAuth, token));
  }).pipe(Effect.withSpan("cloud.cli_token.get_existing"));

  const hasCredential = secrets.get(CLOUD_CLI_SESSION_SECRET).pipe(
    Effect.map(Option.isSome),
    Effect.mapError((cause) => new CloudCliCredentialReadError({ cause })),
  );

  const login = <E, R>(input: {
    readonly showPrompt: (prompt: DeviceAuthorizationPrompt) => Effect.Effect<void, E, R>;
    readonly openBrowser: boolean;
  }) =>
    semaphore
      .withPermits(1)(
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          const cloudAuth = yield* auth;
          prompt = (verification) =>
            Effect.runPromiseWith(context)(
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) => input.showPrompt(toPrompt(verification, now))),
                Effect.andThen(
                  input.openBrowser
                    ? externalLauncher.launchBrowser(verification.verificationUriComplete)
                    : Effect.void,
                ),
                Effect.ignore,
              ),
            );
          const token = yield* Effect.tryPromise({
            try: (signal) =>
              cloudAuth.signIn("passkey", { signal }).then(() => cloudAuth.getRelayIdentityToken()),
            catch: authorizationError,
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                prompt = null;
              }),
            ),
          );
          if (token === null) {
            return yield* new CloudCliAuthorizationError({
              cause: "No identity token after sign-in.",
            });
          }
          return credential(cloudAuth, token);
        }),
      )
      .pipe(Effect.withSpan("cloud.cli_token.login"));

  const clear = Effect.gen(function* () {
    const cloudAuth = yield* auth.pipe(Effect.option);
    if (Option.isSome(cloudAuth)) {
      yield* Effect.promise(() => cloudAuth.value.signOut().catch(() => undefined));
    }
    yield* secrets
      .remove(CLOUD_CLI_SESSION_SECRET)
      .pipe(Effect.mapError((cause) => new CloudCliCredentialRemovalError({ cause })));
  }).pipe(Effect.withSpan("cloud.cli_token.clear"));

  return CloudCliTokenManager.of({ getExisting, hasCredential, login, clear });
});

export const layer = Layer.effect(CloudCliTokenManager, make);
