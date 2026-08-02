import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tests = readdirSync('test')
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => join('test', name));

const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
process.exit(result.status || 0);
