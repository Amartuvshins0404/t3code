import { expect, it } from "vite-plus/test";

import { corsHeaders } from "./cors.ts";

it.each([
  ["https://app.amartuvshin.com", true],
  ["http://localhost:5733", true],
  ["http://127.0.0.1:3773", true],
  ["amaraa-mode://app", true],
  ["t3code-dev://app", true],
  ["https://amartuvshin.com.evil.example", false],
  ["https://evilamartuvshin.com", false],
  ["http://app.amartuvshin.com", false],
  ["http://localhost.evil.example", false],
  ["evil-mode://app", false],
  [undefined, false],
])("allows cross-origin auth calls from %s: %s", (origin, allowed) => {
  expect(corsHeaders(origin)["access-control-allow-origin"]).toBe(allowed ? origin : undefined);
});
