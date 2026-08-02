import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const generatedFiles = [
  'ai-provider-core.js',
  'ai-edit-core.js',
  'editor-ui-core.js',
  'assistant-core.js',
  'assistant-prompt-core.js',
  'assistant-skill-core.js',
  'tool-policy-core.js'
];
const checkOnly = process.argv.includes('--check');
const drifted = [];

for (const name of generatedFiles) {
  const sourcePath = `shared/js/${name}`;
  const targetPath = `extension/js/${name}`;
  const source = readFileSync(sourcePath, 'utf8');
  const target = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;
  if (source === target) continue;
  drifted.push(name);
  if (!checkOnly) writeFileSync(targetPath, source);
}

if (checkOnly && drifted.length) {
  console.error(`扩展生成副本已漂移：${drifted.join(', ')}。运行 npm run sync:extension 后提交。`);
  process.exit(1);
}
if (!checkOnly && drifted.length) console.log(`已同步：${drifted.join(', ')}`);
else console.log(`扩展核心副本一致（${generatedFiles.length} 个文件）`);
