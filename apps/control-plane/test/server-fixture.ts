import { buildControlPlane as build } from "../src/server.js";
import { ControlPlaneDatabase } from "./database-fixture.js";
import type { ControlPlaneConfig } from "../src/config.js";
export * from "../src/server.js";

export async function buildControlPlane(config?: ControlPlaneConfig) {
  if (!config || !process.env.AGENTFLEET_TEST_PG_CONFIG) return build(config);
  const db = new ControlPlaneDatabase(config.databasePath);
  try { return await build(config, db); }
  catch (error) { db.close(); throw error; }
}
