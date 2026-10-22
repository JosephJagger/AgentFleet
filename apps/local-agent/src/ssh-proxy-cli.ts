import { runSshProxy } from "./ssh-proxy.js";

/**
 * A dedicated entry point for `ssh`'s ProxyCommand. Going through the main CLI would load the whole agent for every
 * connection; this file pulls in only what the proxy needs. It accepts the same arguments as `agentfleet ssh-proxy`.
 */
const ALLOWED = new Set(["alias", "socket", "direct-host", "direct-port", "path-dir"]);

function parse(argv: string[]): Map<string, string> | undefined {
  const values = new Map<string, string>();
  const words = argv[0] === "ssh-proxy" ? argv.slice(1) : argv;
  for (let index = 0; index < words.length; index += 2) {
    const key = words[index]?.startsWith("--") ? words[index]!.slice(2) : undefined;
    const value = words[index + 1];
    if (!key || !ALLOWED.has(key) || value === undefined || value.startsWith("--")) return undefined;
    values.set(key, value);
  }
  return values;
}

const values = parse(process.argv.slice(2));
if (!values?.get("alias") || !values.get("socket")) {
  process.stderr.write("agentfleet ssh-proxy: --alias and --socket are required\n");
  process.exit(255);
}
const port = Number(values.get("direct-port"));
process.exit(await runSshProxy({
  alias: values.get("alias")!, socket: values.get("socket")!,
  ...(values.get("direct-host") && Number.isSafeInteger(port) && port > 0 && port < 65536 ? { directHost: values.get("direct-host")!, directPort: port } : {}),
  ...(values.get("path-dir") ? { pathDir: values.get("path-dir")! } : {}),
}));
