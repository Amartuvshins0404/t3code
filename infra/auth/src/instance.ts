import pg from "pg";

import { createAuth } from "./auth.ts";
import { loadConfig } from "./config.ts";

export const config = loadConfig();
export const pool = new pg.Pool({ connectionString: config.databaseUrl });
export const auth = createAuth(config, pool);
