import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const apiToken = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    const accountId = yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID");
    const zoneId = yield* Config.NonEmptyString("CLOUDFLARE_ZONE_ID");
    const layerCredentials = fromApiToken({ apiToken }).pipe(
      Layer.provideMerge(FetchHttpClient.layer),
    );

    const tunnels: ManagedEndpointProvider.CloudflareTunnelApi<never> = {
      get: (tunnelId) => provide(zeroTrust.getTunnelCloudflared({ accountId, tunnelId })),
      list: (request) => provide(zeroTrust.listTunnelCloudflareds({ accountId, ...request })),
      create: (request) => provide(zeroTrust.createTunnelCloudflared({ accountId, ...request })),
      putConfiguration: (tunnelId, config) =>
        provide(zeroTrust.putTunnelCloudflaredConfiguration({ accountId, tunnelId, config })),
      getConfiguration: (tunnelId) =>
        provide(zeroTrust.getTunnelCloudflaredConfiguration({ accountId, tunnelId })),
      getToken: (tunnelId) => provide(zeroTrust.getTunnelCloudflaredToken({ accountId, tunnelId })),
      delete: (tunnelId) => provide(zeroTrust.deleteTunnelCloudflared({ accountId, tunnelId })),
    };
    const records: ManagedEndpointProvider.CloudflareDnsApi<never> = {
      listDnsRecords: (request) => provide(dns.listRecords({ zoneId, ...request })),
      createDnsRecord: (request) => provide(dns.createRecord({ zoneId, ...request })),
      updateDnsRecord: (dnsRecordId, request) =>
        provide(dns.updateRecord({ zoneId, dnsRecordId, ...request })),
      deleteDnsRecord: (dnsRecordId) => provide(dns.deleteRecord({ zoneId, dnsRecordId })),
    };

    function provide<A, E, R>(effect: Effect.Effect<A, E, R>) {
      return effect.pipe(Effect.provide(layerCredentials));
    }

    return ManagedEndpointProvider.layerCloudflareClients(tunnels, records, (effect) => effect);
  }),
);
