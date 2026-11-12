import * as NodeHttp from "node:http";

import { toNodeHandler } from "better-auth/node";

import { devicePage } from "./devicePage.ts";
import { auth, config, pool } from "./instance.ts";
import { migrate } from "./migrate.ts";

await migrate(pool);

const authHandler = toNodeHandler(auth);

const server = NodeHttp.createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return void authHandler(req, res);
  if (path === "/device" && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    });
    return void res.end(req.method === "HEAD" ? undefined : devicePage);
  }
  if (path === "/") {
    res.writeHead(302, { location: "/device" });
    return void res.end();
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

server.listen(config.port, () => console.log(`auth listening on :${config.port}`));

const shutdown = () => server.close(() => void pool.end().then(() => process.exit(0)));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
