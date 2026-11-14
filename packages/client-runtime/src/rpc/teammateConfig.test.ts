import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { WsRpcProtocolClient } from "./protocol.ts";
import { teammateProtocolClient } from "./teammateConfig.ts";

const wire: string[] = [];
const fakeClient = new Proxy(
  {},
  {
    get: (_target, property) => () => {
      wire.push(String(property));
      return Effect.succeed("sent");
    },
  },
) as WsRpcProtocolClient;

describe("teammate connection", () => {
  it.effect("keeps calls outside the teammate allowlist off the wire", () =>
    Effect.gen(function* () {
      wire.length = 0;
      const client = teammateProtocolClient(fakeClient);
      const refused = yield* Effect.flip(client[WS_METHODS.serverGetConfig]({}));
      expect(refused).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      const streamRefusal = yield* Effect.flip(
        Stream.runDrain(client[WS_METHODS.subscribeServerLifecycle]({})),
      );
      expect(streamRefusal).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      expect(wire).toEqual([]);

      void client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand];
      (client[WS_METHODS.teamReportPresence] as (input: unknown) => unknown)({ typing: false });
      expect(wire).toEqual([WS_METHODS.teamReportPresence]);
    }),
  );
});
