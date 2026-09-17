import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;

export type ProxyCommandRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

interface WindowsProxySettings {
  proxyEnable?: unknown;
  proxyServer?: unknown;
}

function enabled(values: Map<string, string>, key: string): boolean {
  return values.get(`${key}Enable`) === "1";
}

function proxyUrl(values: Map<string, string>, key: string, scheme: "http" | "socks5h"): string | undefined {
  if (!enabled(values, key)) return undefined;
  const host = values.get(`${key}Proxy`)?.trim();
  const port = Number(values.get(`${key}Port`));
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65_535 || /[\s\0/@?#]/u.test(host)) return undefined;
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  try {
    const url = new URL(`${scheme}://${authority}:${port}`);
    return url.hostname && url.port === String(port) ? url.toString().replace(/\/$/u, "") : undefined;
  } catch { return undefined; }
}

export function parseMacSystemProxy(output: string): Partial<NodeJS.ProcessEnv> {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/u.exec(line);
    if (match?.[1] && match[2] !== undefined) values.set(match[1], match[2]);
  }
  const http = proxyUrl(values, "HTTP", "http");
  const https = proxyUrl(values, "HTTPS", "http");
  const socks = proxyUrl(values, "SOCKS", "socks5h");
  return {
    ...(http ? { HTTP_PROXY: http } : {}),
    ...(https ? { HTTPS_PROXY: https } : {}),
    ...(!http && !https && socks ? { ALL_PROXY: socks } : {}),
  };
}

function windowsProxyEndpoint(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || /[\s\0/@?#]/u.test(trimmed)) return undefined;
  const authority = trimmed.includes(":") && !trimmed.startsWith("[") ? trimmed : `${trimmed}`;
  try {
    const url = new URL(`http://${authority}`);
    return url.hostname && url.port ? url.toString().replace(/\/$/u, "") : undefined;
  } catch { return undefined; }
}

/**
 * Windows records a manual system proxy in the current user's Internet Settings
 * registry key. The scheduled Agent task does not inherit browser environment
 * variables, so pass this explicit, already-enabled setting to Codex.
 */
export function parseWindowsSystemProxy(output: string): Partial<NodeJS.ProcessEnv> {
  let settings: WindowsProxySettings;
  try { settings = JSON.parse(output) as WindowsProxySettings; } catch { return {}; }
  if (settings.proxyEnable !== 1 || typeof settings.proxyServer !== "string") return {};
  const entries = new Map<string, string>();
  for (const entry of settings.proxyServer.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) {
      entries.set("http", entry);
      entries.set("https", entry);
      continue;
    }
    const scheme = entry.slice(0, separator).trim().toLowerCase();
    if (scheme === "http" || scheme === "https") entries.set(scheme, entry.slice(separator + 1));
  }
  const http = entries.get("http") ? windowsProxyEndpoint(entries.get("http")!) : undefined;
  const https = entries.get("https") ? windowsProxyEndpoint(entries.get("https")!) : undefined;
  return {
    ...(http ? { HTTP_PROXY: http } : {}),
    ...(https ? { HTTPS_PROXY: https } : {}),
  };
}

export async function codexNetworkEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  runner: ProxyCommandRunner = async (file, args) => execFileAsync(file, args, { encoding: "utf8", timeout: 2_000, maxBuffer: 32_768 }),
): Promise<NodeJS.ProcessEnv> {
  const result = { ...environment };
  if (PROXY_KEYS.some((key) => result[key])) return result;
  try {
    const detected = platform === "darwin"
      ? parseMacSystemProxy((await runner("/usr/sbin/scutil", ["--proxy"])).stdout)
      : platform === "win32"
        ? parseWindowsSystemProxy((await runner("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-Command",
          "$p=Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';[pscustomobject]@{proxyEnable=$p.ProxyEnable;proxyServer=$p.ProxyServer}|ConvertTo-Json -Compress",
        ])).stdout)
        : {};
    Object.assign(result, detected);
    if (Object.keys(detected).length > 0 && !result.NO_PROXY && !result.no_proxy) result.NO_PROXY = "localhost,127.0.0.1,::1";
  } catch { /* A missing or unreadable system proxy leaves Codex on direct networking. */ }
  return result;
}
