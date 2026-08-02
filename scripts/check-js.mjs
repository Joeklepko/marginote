import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['shared', 'extension', 'test', 'scripts', 'desktop/scripts'];
const ignoredDirectories = new Set(['vendor', 'node_modules', 'target', 'dist']);

function collect(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) collect(join(directory, entry.name), output);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      output.push(join(directory, entry.name));
    }
  }
  return output;
}

const files = roots.flatMap(root => collect(root)).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`JavaScript syntax OK (${files.length} files)`);
