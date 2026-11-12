import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";

export const layerManagedEndpointProvider = (
  tunnelClient: Cloudflare.Tunnel.ReadWriteTunnelClient,
  dnsClient: Cloudflare.DNS.ReadWriteDnsClient,
  alchemyRuntimeContext: Alchemy.BaseRuntimeContext,
) =>
  ManagedEndpointProvider.layerCloudflareClients<Alchemy.RuntimeContext>(
    tunnelClient,
    dnsClient,
    Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
  );

export const layerApnsDeliveryQueue = (
  sender: Cloudflare.Queues.WriteQueueClient,
  alchemyRuntimeContext: Alchemy.BaseRuntimeContext,
) =>
  ApnsDeliveryQueue.layer.pipe(
    Layer.provide(
      Layer.succeed(
        ApnsDeliveryQueue.ApnsDeliveryQueueSender,
        ApnsDeliveryQueue.ApnsDeliveryQueueSender.of({
          send: Effect.fn("ApnsDeliveryQueueSender.send")(
            function* (body) {
              return yield* sender.send(body);
            },
            Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
          ),
        }),
      ),
    ),
  );
