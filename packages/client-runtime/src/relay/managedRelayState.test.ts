import { EnvironmentId } from "@t3tools/contracts";
import {
  type RelayClientDeviceRecord,
  type RelayClientEnvironmentRecord,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, vi } from "vite-plus/test";

import { getConnectName } from "../appName.ts";
import * as ManagedRelay from "./managedRelay.ts";
import {
  createManagedRelayQueryManager,
  createManagedRelaySession,
  deregisterManagedRelayEnvironment,
  ManagedRelaySessionError,
  managedRelaySessionAtom,
  setManagedRelaySession,
  setManagedRelayTeamConnectivity,
} from "./managedRelayState.ts";
import { createRuntimeCommand, runAtomCommand } from "../state/runtime.ts";

let registry = AtomRegistry.make();

const environment = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "Main environment",
  endpoint: {
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
    providerKind: "cloudflare_tunnel",
  },
  linkedAt: "2026-06-01T00:00:00.000Z",
} satisfies RelayClientEnvironmentRecord;

const device = {
  deviceId: "device-1",
  label: "Julius iPhone",
  platform: "ios",
  iosMajorVersion: 18,
  appVersion: null,
  notifications: {
    enabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
  liveActivities: {
    enabled: true,
  },
  updatedAt: "2026-06-01T00:00:00.000Z",
} satisfies RelayClientDeviceRecord;

function resetRegistry() {
  registry.dispose();
  registry = AtomRegistry.make();
}

function createClient(overrides?: Partial<ManagedRelay.ManagedRelayClient["Service"]>) {
  return ManagedRelay.ManagedRelayClient.of({
    relayUrl: "https://relay.example.test",
    listEnvironments: () => Effect.succeed([environment]),
    listDevices: () => Effect.succeed([device]),
    createEnvironmentLinkChallenge: () => Effect.die("unused"),
    listTeamEnvironments: () => Effect.die("unused"),
    listEnvironmentTeamShares: () => Effect.die("unused"),
    shareEnvironmentWithTeam: () => Effect.die("unused"),
    unshareEnvironmentWithTeam: () => Effect.die("unused"),
    getTeamConnectivity: () => Effect.die("unused"),
    setTeamConnectivity: () => Effect.die("unused"),
    removeTeamConnectivity: () => Effect.die("unused"),
    linkEnvironment: () => Effect.die("unused"),
    unlinkEnvironment: () => Effect.die("unused"),
    getEnvironmentStatus: () =>
      Effect.succeed({
        environmentId: environment.environmentId,
        endpoint: environment.endpoint,
        status: "online",
        checkedAt: "2026-06-01T00:00:00.000Z",
      }),
    connectEnvironment: () => Effect.die("unused"),
    registerDevice: () => Effect.die("unused"),
    unregisterDevice: () => Effect.die("unused"),
    registerLiveActivity: () => Effect.die("unused"),
    getAgentActivitySnapshot: () => Effect.die("unused"),
    resetTokenCache: Effect.void,
    ...overrides,
  });
}

function setSession() {
  setManagedRelaySession(registry, {
    accountId: "account-1",
    readIdentityToken: () => Promise.resolve("identity-token"),
  });
}

function holdsText(value: unknown, text: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return value.includes(text);
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  const entries: ReadonlyArray<unknown> =
    value instanceof Map ? [...value.entries()] : Object.values(value);
  return entries.some((entry) => holdsText(entry, text, seen));
}

function identityToken(expiresAtSeconds: number): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${encode({ alg: "RS256" })}.${encode({ exp: expiresAtSeconds })}.c2lnbmF0dXJl`;
}

describe("createManagedRelayQueryManager", () => {
  afterEach(resetRegistry);

  it.effect("logs a failed device listing once however many readers mount it", () =>
    Effect.gen(function* () {
      const logs: Array<unknown> = [];
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(
            ManagedRelay.ManagedRelayClient,
            createClient({
              listDevices: () =>
                Effect.fail(
                  new ManagedRelay.ManagedRelayRequestFailedError({
                    action: "list relay client devices",
                    cause: new Error("relay down"),
                  }),
                ),
            }),
          ),
          Logger.layer([Logger.make(({ message }) => logs.push(message))], {
            mergeWithExisting: false,
          }),
        ),
      );
      const manager = createManagedRelayQueryManager(runtime);
      setSession();
      const atom = manager.devicesAtom("account-1");

      const failed = Promise.withResolvers<void>();
      const readers = [0, 1].map(() =>
        registry.subscribe(
          atom,
          (result) => {
            if (result._tag === "Failure") failed.resolve();
          },
          { immediate: true },
        ),
      );
      yield* Effect.promise(() => failed.promise);
      for (const unsubscribe of readers) unsubscribe();

      expect(logs).toEqual([["[t3-cloud] Relay device listing failed"]]);
    }),
  );

  it.effect("forgets the team proxy access key once the save returns", () =>
    Effect.gen(function* () {
      const accessKey = "fake-team-access-key-0000";
      const record = {
        organizationId: "team-a",
        url: "https://proxy.example.test",
        version: "v1",
        updatedAt: "2026-11-15T00:00:00.000Z",
        updatedBy: { userId: "user-1", name: "Ada" },
      };
      const setTeamConnectivity = vi.fn(() => Effect.succeed(record));
      const runtime = Atom.runtime(
        Layer.succeed(
          ManagedRelay.ManagedRelayClient,
          createClient({
            setTeamConnectivity,
            getTeamConnectivity: () => Effect.succeed(record),
          }),
        ),
      );
      const manager = createManagedRelayQueryManager(runtime);
      setSession();
      const save = createRuntimeCommand(runtime, {
        label: "test:set-team-connectivity",
        execute: (
          input: {
            readonly accountId: string;
            readonly organizationId: string;
            readonly url: string;
            readonly clientKey: string;
          },
          commandRegistry,
        ) => setManagedRelayTeamConnectivity(commandRegistry, input),
      });
      const view = registry.subscribe(
        manager.teamConnectivityAtom("account-1", "team-a"),
        () => {},
      );

      const result = yield* Effect.promise(() =>
        runAtomCommand(registry, save, {
          accountId: "account-1",
          organizationId: "team-a",
          url: record.url,
          clientKey: accessKey,
        }),
      );
      manager.refreshTeamConnectivity(registry, "account-1", "team-a");
      view();

      expect(result._tag).toBe("Success");
      expect(setTeamConnectivity).toHaveBeenCalledWith(
        expect.objectContaining({ clientKey: accessKey }),
      );
      const held = [...registry.getNodes().values()].flatMap((node) =>
        Option.toArray(node.valueOption()),
      );
      expect(held.some((value) => holdsText(value, accessKey))).toBe(false);
    }),
  );

  it.effect("rejects deregistration after the account changes", () =>
    Effect.gen(function* () {
      const unlinkEnvironment = vi.fn(() => Effect.succeed({ ok: true }));
      setSession();

      const error = yield* deregisterManagedRelayEnvironment(registry, {
        accountId: "previous-account",
        environmentId: environment.environmentId,
      }).pipe(
        Effect.provideService(ManagedRelay.ManagedRelayClient, createClient({ unlinkEnvironment })),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(ManagedRelaySessionError);
      expect(unlinkEnvironment).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "deduplicates concurrent identity token reads and reuses the token until JWT expiry",
    () =>
      Effect.gen(function* () {
        const token = identityToken(4_102_444_800);
        let resolveToken!: (value: string) => void;
        const readIdentityToken = vi.fn(
          () =>
            new Promise<string>((resolve) => {
              resolveToken = resolve;
            }),
        );
        const session = createManagedRelaySession({
          accountId: "account-1",
          readIdentityToken,
        });

        const readsFiber = yield* Effect.all(
          [session.readIdentityToken(), session.readIdentityToken()],
          {
            concurrency: "unbounded",
          },
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(readIdentityToken).toHaveBeenCalledTimes(1);

        resolveToken(token);
        expect(yield* Fiber.join(readsFiber)).toEqual([token, token]);
        expect(yield* session.readIdentityToken()).toBe(token);
        expect(readIdentityToken).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect("replaces an identity token read that has not answered after 4 seconds", () =>
    Effect.gen(function* () {
      const token = identityToken(4_102_444_800);
      const readIdentityToken = vi
        .fn<() => Promise<string | null>>()
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValue(token);
      const session = createManagedRelaySession({ accountId: "account-1", readIdentityToken });

      const readsFiber = yield* Effect.all(
        [session.readIdentityToken(), session.readIdentityToken()],
        {
          concurrency: "unbounded",
        },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("3999 millis");
      expect(readIdentityToken).toHaveBeenCalledTimes(1);

      yield* TestClock.adjust("1 millis");
      expect(yield* Fiber.join(readsFiber)).toEqual([token, token]);
      expect(readIdentityToken).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("fails an identity token read that never answers after three tries", () =>
    Effect.gen(function* () {
      const readIdentityToken = vi.fn(() => new Promise<string | null>(() => {}));
      const session = createManagedRelaySession({ accountId: "account-1", readIdentityToken });

      const readFiber = yield* session.readIdentityToken().pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("12 seconds");

      expect((yield* Fiber.join(readFiber)).message).toBe(
        `Timed out obtaining the ${getConnectName()} session token.`,
      );
      expect(readIdentityToken).toHaveBeenCalledTimes(3);
    }),
  );

  it.effect("updates the token provider without replacing a same-account session", () =>
    Effect.gen(function* () {
      const firstRead = vi.fn(() => Promise.resolve<string | null>(null));
      setManagedRelaySession(registry, {
        accountId: "account-1",
        readIdentityToken: firstRead,
      });
      const firstSession = registry.get(managedRelaySessionAtom);
      expect(firstSession).not.toBeNull();
      expect(yield* firstSession!.readIdentityToken()).toBeNull();

      const secondRead = vi.fn(() => Promise.resolve<string | null>("refreshed-token"));
      setManagedRelaySession(registry, {
        accountId: "account-1",
        readIdentityToken: secondRead,
      });

      expect(registry.get(managedRelaySessionAtom)).toBe(firstSession);
      expect(yield* firstSession!.readIdentityToken()).toBe("refreshed-token");
      expect(firstRead).toHaveBeenCalledTimes(1);
      expect(secondRead).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("does not pin a refreshed session to an older pending token read", () =>
    Effect.gen(function* () {
      let resolveFirst!: (token: string) => void;
      setManagedRelaySession(registry, {
        accountId: "account-1",
        readIdentityToken: () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve;
          }),
      });
      const session = registry.get(managedRelaySessionAtom);
      const firstRead = yield* session!.readIdentityToken().pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      setManagedRelaySession(registry, {
        accountId: "account-1",
        readIdentityToken: () => Promise.resolve("refreshed-token"),
      });

      expect(yield* session!.readIdentityToken()).toBe("refreshed-token");
      resolveFirst("older-token");
      expect(yield* Fiber.join(firstRead)).toBe("older-token");
    }),
  );
});
