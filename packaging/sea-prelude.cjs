if (process.env.NODE_NO_WARNINGS !== "1") {
  const { spawnSync } = require("node:child_process");
  const child = spawnSync(process.execPath, process.argv.slice(2), {
    stdio: "inherit",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  process.exit(child.status === null ? 1 : child.status);
}

/* The bundled SDK uses import.meta.url for Node module resolution. */
const __agentfleetModuleUrl = require("node:url").pathToFileURL(process.argv[1] ?? process.execPath).href;
