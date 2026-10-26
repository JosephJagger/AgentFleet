import {it,expect} from 'vitest';
import {managedHostPlatform,managedVersionNumber} from './managed-host';
it.each([
 ['linux 26.04','x64','linux-x64'],['linux 24.04','aarch64','linux-arm64'],
 ['darwin 25.0.0','arm64','darwin-arm64'],['macos 15.1','x86_64','darwin-x64'],
 ['win32 10.0.26100','x64','win32-x64'],['Windows 11','AMD64','win32-x64'],
 ['freebsd 14','x64',undefined],['linux 26.04','riscv64',undefined],
])('maps display OS %s and arch %s to %s',(os,arch,expected)=>expect(managedHostPlatform({os,arch})).toBe(expected));
it('uses the protocol platform independently of localized presentation',()=>{
 expect(managedHostPlatform({platform:'linux',os:'Ubuntu 工作站 26.04',arch:'x64'})).toBe('linux-x64');
});
it.each([['2.1.310 (Claude Code)','2.1.310'],['grok 1.0.62 (1474f9cbdd91) [stable]','1.0.62'],['not installed',undefined]])('normalizes actual CLI banners %s',(value,expected)=>expect(managedVersionNumber(value)).toBe(expected));
