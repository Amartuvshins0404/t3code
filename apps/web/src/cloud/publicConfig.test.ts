import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig } from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasCloudPublicConfig", () => {
  it.each([
    ["https://auth.example.test", "http://relay.example.test", false],
    ["http://auth.example.test", "https://relay.example.test", false],
    ["http://localhost:3000", "https://relay.example.test", true],
    ["https://auth.example.test", "https://relay.example.test", true],
  ])("auth %s with relay %s enables T3 Connect: %s", (authUrl, relayUrl, expected) => {
    vi.stubEnv("VITE_T3CODE_AUTH_URL", authUrl);
    vi.stubEnv("VITE_T3CODE_RELAY_URL", relayUrl);

    expect(hasCloudPublicConfig()).toBe(expected);
  });
});
