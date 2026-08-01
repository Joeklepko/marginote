import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = join(desktopDir, 'src-tauri');
const cliDir = join(desktopDir, 'cli');
const rustInfo = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
const host = /^host:\s+(\S+)$/m.exec(rustInfo)?.[1];
if (!host) throw new Error('无法从 rustc -vV 获取 target triple');

execFileSync('cargo', [
  'build',
  '--manifest-path', join(cliDir, 'Cargo.toml'),
  '--release'
], { cwd: desktopDir, stdio: 'inherit' });

const extension = process.platform === 'win32' ? '.exe' : '';
const source = join(cliDir, 'target', 'release', `marginote-cli${extension}`);
const binaryDir = join(tauriDir, 'binaries');
const destination = join(binaryDir, `marginote-cli-${host}${extension}`);
mkdirSync(binaryDir, { recursive: true });
copyFileSync(source, destination);
console.log(`CLI sidecar ready: ${destination}`);
