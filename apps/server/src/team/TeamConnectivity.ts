import type { TeamConnectivityStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readRelayConnection } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { makeRelayEnvironmentClient } from "../relay/relayEnvironmentClient.ts";
import { readSharedOrganizationIds } from "./sharedOrganizations.ts";
import {
  applyRelayTeamConnectivity,
  decideTeamTurnRoute,
  isTeamConnectivityDriver,
  type TeamConnectivityMemory,
  TeamConnectivityUnavailableError,
  teamConnectivityStatus,
  teamProviderConfig,
  teamProviderEnvironment,
  TeamProviderRoutes,
  type TeamProviderRoutesShape,
  teamRouteOrganization,
  withSharedOrganizations,
} from "./TeamProviderRoutes.ts";

export class TeamConnectivity extends Context.Service<
  TeamConnectivity,
  {
    readonly status: (input: {
      readonly refresh: boolean;
      readonly organizationId?: string | undefined;
    }) => Effect.Effect<TeamConnectivityStatus>;
    readonly refresh: Effect.Effect<void>;
    readonly sharedOrganizationsChanged: (
      organizationIds: ReadonlyArray<string>,
    ) => Effect.Effect<void>;
  }
>()("t3/team/TeamConnectivity") {}

const CONFIGURED_SECRET = "team-connectivity-configured";
const STALE_AFTER_MS = 5 * 60 * 1000;

const ConfiguredTeams = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeConfiguredTeams = Schema.decodeUnknownOption(ConfiguredTeams);
const encodeConfiguredTeams = Schema.encodeEffect(ConfiguredTeams);

const failureTag = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause);
  return typeof failure === "object" && failure !== null && "_tag" in failure
    ? String(failure._tag)
    : "unknown";
};

interface State {
  readonly memory: TeamConnectivityMemory;
  readonly fetchedAtMs: number | null;
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const layerScope = yield* Scope.Scope;
  const fetches = yield* Semaphore.make(1);

  const sharedOrganizationIds = yield* readSharedOrganizationIds(secrets).pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  const storedConfigured = yield* secrets.get(CONFIGURED_SECRET).pipe(
    Effect.map((stored) =>
      Option.isNone(stored)
        ? {}
        : Option.getOrElse(
            decodeConfiguredTeams(new TextDecoder().decode(stored.value)),
            () => ({}),
          ),
    ),
    Effect.orElseSucceed((): Record<string, string> => ({})),
  );
  const state = yield* Ref.make<State>({
    memory: withSharedOrganizations(
      {
        sharedOrganizationIds,
        connections: new Map(),
        configured: new Map(Object.entries(storedConfigured)),
      },
      sharedOrganizationIds,
    ),
    fetchedAtMs: null,
  });

  const persistConfigured = Effect.fn("TeamConnectivity.persistConfigured")(function* (
    configured: ReadonlyMap<string, string>,
  ) {
    if (configured.size === 0) {
      yield* secrets.remove(CONFIGURED_SECRET);
      return;
    }
    const encoded = yield* encodeConfiguredTeams(Object.fromEntries(configured));
    yield* secrets.set(CONFIGURED_SECRET, new TextEncoder().encode(encoded));
  });

  const commit = Effect.fn("TeamConnectivity.commit")(function* (next: State) {
    const previous = yield* Ref.getAndSet(state, next);
    const before = previous.memory.configured;
    const after = next.memory.configured;
    const changed =
      before.size !== after.size ||
      [...after].some(([organizationId, version]) => before.get(organizationId) !== version);
    if (changed) {
      yield* persistConfigured(next.memory.configured).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not save which teams have a provider connection", {
            reason: failureTag(cause),
          }),
        ),
      );
    }
  });

  const fetchOnce = Effect.gen(function* () {
    const connection = yield* readRelayConnection;
    if (connection === null) return;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const client = yield* makeRelayEnvironmentClient(connection);
    const response = yield* client.server.readEnvironmentTeamConnectivity({
      params: { environmentId },
    });
    const localShared = yield* readSharedOrganizationIds(secrets);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const current = yield* Ref.get(state);
    yield* commit({
      memory: applyRelayTeamConnectivity(current.memory, localShared, response),
      fetchedAtMs: now,
    });
  }).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secrets));

  const refreshWithin = (timeout: `${number} seconds`) =>
    fetches
      .withPermits(1)(fetchOnce)
      .pipe(
        Effect.timeout(timeout),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not read team provider connectivity from T3 Connect", {
            reason: failureTag(cause),
          }),
        ),
        Effect.withSpan("TeamConnectivity.refresh"),
      );

  const refresh = refreshWithin("10 seconds");

  const isStale = Effect.gen(function* () {
    const { fetchedAtMs } = yield* Ref.get(state);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return fetchedAtMs === null || now - fetchedAtMs > STALE_AFTER_MS;
  });

  const refreshIfStale = Effect.gen(function* () {
    if (yield* isStale) yield* refreshWithin("5 seconds");
  });

  const status: TeamConnectivity["Service"]["status"] = Effect.fn("TeamConnectivity.status")(
    function* (input) {
      if (input.refresh) yield* refresh;
      const { memory, fetchedAtMs } = yield* Ref.get(state);
      const checkedAt = DateTime.formatIso(
        fetchedAtMs === null ? yield* DateTime.now : DateTime.makeUnsafe(fetchedAtMs),
      );
      return teamConnectivityStatus(memory, { checkedAt, organizationId: input.organizationId });
    },
  );

  const sharedOrganizationsChanged: TeamConnectivity["Service"]["sharedOrganizationsChanged"] =
    Effect.fn("TeamConnectivity.sharedOrganizationsChanged")(function* (organizationIds) {
      const current = yield* Ref.get(state);
      const added = organizationIds.some(
        (id) => !current.memory.sharedOrganizationIds.includes(id),
      );
      yield* commit({
        memory: withSharedOrganizations(current.memory, organizationIds),
        fetchedAtMs: current.fetchedAtMs,
      });
      if (added) yield* refresh.pipe(Effect.forkIn(layerScope), Effect.asVoid);
    });

  const routes: TeamProviderRoutesShape = {
    routeTurn: Effect.fn("TeamConnectivity.routeTurn")(function* (input) {
      const before = yield* Ref.get(state);
      if (teamRouteOrganization(before.memory, input) === undefined)
        return { type: "owner" as const };
      yield* refreshIfStale;
      return decideTeamTurnRoute((yield* Ref.get(state)).memory, input);
    }),
    openAdapter: Effect.fn("TeamConnectivity.openAdapter")(function* ({ session, instanceId }) {
      const unavailable = new TeamConnectivityUnavailableError({
        organizationId: session.organizationId,
      });
      const connectionFor = Effect.gen(function* () {
        const { memory } = yield* Ref.get(state);
        const connection = memory.connections.get(session.organizationId);
        return memory.sharedOrganizationIds.includes(session.organizationId) &&
          connection?.version === session.version
          ? connection
          : undefined;
      });
      let connection = yield* connectionFor;
      if (connection === undefined) {
        yield* refreshIfStale;
        connection = yield* connectionFor;
      }
      if (connection === undefined) return yield* unavailable;
      const instance = yield* instances.getInstance(instanceId);
      const build = instances.buildDetachedAdapter;
      if (
        instance === undefined ||
        build === undefined ||
        !isTeamConnectivityDriver(instance.driverKind)
      ) {
        return yield* unavailable;
      }
      const driver = instance.driverKind;
      const routed = connection;
      return yield* build({
        instanceId,
        environment: (_driver, environment) => teamProviderEnvironment(driver, environment, routed),
        config: (_driver, config) => teamProviderConfig(driver, config, routed),
      }).pipe(Effect.mapError(() => unavailable));
    }),
  };

  yield* refresh.pipe(Effect.forkIn(layerScope));

  return {
    connectivity: TeamConnectivity.of({ status, refresh, sharedOrganizationsChanged }),
    routes,
  };
});

export const layer = Layer.effectContext(
  make.pipe(
    Effect.map(({ connectivity, routes }) =>
      Context.make(TeamConnectivity, connectivity).pipe(Context.add(TeamProviderRoutes, routes)),
    ),
  ),
);
