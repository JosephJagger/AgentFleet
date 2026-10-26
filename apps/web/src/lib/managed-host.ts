import type {Machine} from './types';

/** Use the protocol platform, never the display label containing an OS release. */
export function managedHostPlatform(machine:Pick<Machine,'os'|'platform'|'arch'>):string|undefined {
  const raw=(machine.platform||machine.os||'').trim().toLowerCase().split(/\s+/)[0];
  const platform=raw==='windows'?'win32':raw==='macos'?'darwin':raw;
  const architecture=(machine.arch||'').toLowerCase();
  const arch=architecture==='amd64'||architecture==='x86_64'?'x64':architecture==='aarch64'?'arm64':architecture;
  return platform&&['linux','darwin','win32'].includes(platform)&&['x64','arm64'].includes(arch)?`${platform}-${arch}`:undefined;
}
/** Native CLIs report banners such as `2.1.310 (Claude Code)` or `grok 1.0.62 […]`. */
export const managedVersionNumber=(value?:string|null):string|undefined=>value?.match(/\b\d+\.\d+\.\d+\b/)?.[0];
