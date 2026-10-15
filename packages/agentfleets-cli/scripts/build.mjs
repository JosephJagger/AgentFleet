import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const destination = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, 'installers'), { recursive: true });
for (const file of ['install.sh', 'install-macos.sh', 'install.ps1', 'windows-launcher.cmd']) {
  await copyFile(join(root, 'packaging', file), join(destination, 'installers', file));
}
await copyFile(join(root, 'LICENSE'), join(destination, 'LICENSE'));
console.log('Built npm installer resources from packaging/ (no installation performed).');
