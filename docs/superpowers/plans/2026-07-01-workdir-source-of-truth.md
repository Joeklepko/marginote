# 桌面版工作目录为唯一数据源 + 直接文件操作 + 回收站 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面版（Tauri）把工作目录变为强制且唯一的数据源，所有增删改移直接操作磁盘真实文件/文件夹，删除进 `回收站/` 保留 30 天，并修复"磁盘有文件却不导入"。

**Architecture:** 磁盘=唯一数据源；内存数组=工作副本；localStorage 仅启动缓存。结构性操作经统一 `fileops` 层 write-through 到磁盘；删除经 `trash` 层移入 `回收站/`（索引 `_marginote/trash.json`）。全部桌面改动用 `isDesktopContext()` 门控，扩展版不变。

**Tech Stack:** 原生 JS（浏览器全局 IIFE + Node 双导出以便离线测试）、Tauri v2（Rust 命令）、`node` 跑纯逻辑测试。

## Global Constraints（每个任务都隐含遵守）

- 仅改**桌面版**行为；所有新逻辑入口用 `isDesktopContext()`（`shared/app.js` 已有）门控，扩展版/纯网页走原路径。
- 不改磁盘文件格式：笔记 `笔记本名/标题.md`（frontmatter 带 `id`）、`待办/*.md`、画板 `*.excalidraw`、资产 `_assets/`、元数据 `_marginote/meta.json`。
- 新增回收站目录 `回收站/`、索引 `_marginote/trash.json`。回收站保留 **30 天**。
- 每次改完必须 `node --check` 通过对应 JS 文件；纯逻辑任务必须有可 `node` 跑通的测试。
- Rust 改动后需 `cd desktop/src-tauri && cargo check` 通过（本机可跑 cargo）。
- 提交频繁，每个任务结束提交一次；**不打 git tag**（用户要求）。
- 平台 fs 契约在 `shared/js/platform.js`，桌面实现在 `shared/js/platform-desktop.js`，Rust 命令在 `desktop/src-tauri/src/workdir.rs` + 注册在 `lib.rs`。
- 现有全局：`notes/todos/notebooks/folders/images` 数组、`saveData()`、`fsApi()`（返回 `mn.platform.fs`）、`noteRelPath(note,usedPaths)`/`drawingRelPath`、`safeName()`、`TODO_DIR='待办'`、`WORKDIR_META='_marginote/meta.json'`、`_workdirCfg`、`renderNotesList/renderNotebooks/renderTodos`。

---

## 文件结构

- **Create** `shared/js/trash-core.js` — 回收站纯逻辑（无 fs/DOM）：唯一名、恢复目标路径、过期判定、过期分区。浏览器全局 `window.trashCore` + Node `module.exports`。
- **Create** `shared/js/import-plan.js` — 导入决策纯逻辑：给定磁盘文件与已载入 id，决定读哪些（绝不跳过未载入文件）、排除 `回收站/`。双导出。
- **Create** `shared/js/trash.js` — 回收站操作（desktop）：`moveToTrash / restoreFromTrash / purgeExpired`，读写 `_marginote/trash.json`，调用 `trashCore` + `fsApi()`。浏览器全局 `window.trash`。
- **Create** `shared/js/fileops.js` — 写穿层（desktop）：note/todo/notebook/folder 的 建/改/移/删 → 磁盘 + 内存。浏览器全局 `window.fileops`。
- **Create** `test/trash-core.test.js`、`test/import-plan.test.js` — Node 测试（断言 + 退出码）。
- **Modify** `shared/js/platform.js` — fs 契约加 `mkdir`、`move`。
- **Modify** `shared/js/platform-desktop.js` — 实现 `mkdir`、`move`（invoke 新命令）。
- **Modify** `desktop/src-tauri/src/workdir.rs` — `cmd_workdir_mkdir`、`cmd_workdir_move`。
- **Modify** `desktop/src-tauri/src/lib.rs` — 注册两个新命令。
- **Modify** `shared/app.js` — 去增量跳过、排除 `回收站/`、空目录清理豁免当前笔记本、UI 删/移/改接 `fileops`、正文防抖写穿、强制工作目录 + 迁移 + 启动编排、回收站视图逻辑。
- **Modify** `shared/js/assistant.js` — AI 写工具改调 `fileops`。
- **Modify** `shared/index.html` — 加载 trash-core/import-plan/trash/fileops 脚本、回收站视图 DOM/样式。

---

## Task 1: 平台 fs 增加 mkdir / move（Rust + 桥 + 契约）

**Files:**
- Modify: `desktop/src-tauri/src/workdir.rs`（新增两个命令，仿 `cmd_workdir_remove` 用 `resolve_rel` 防越界）
- Modify: `desktop/src-tauri/src/lib.rs`（`generate_handler!` 注册）
- Modify: `shared/js/platform.js`（契约默认值）
- Modify: `shared/js/platform-desktop.js`（invoke 实现）

**Interfaces:**
- Produces: `mn.platform.fs.mkdir(relPath) → Promise<bool>`（递归建目录，已存在视为成功）；`mn.platform.fs.move(fromRel, toRel) → Promise<bool>`（重命名/移动，自动建目标父目录）。

- [ ] **Step 1: Rust 加命令**（`workdir.rs`，仿现有 `cmd_workdir_remove`）

```rust
#[tauri::command]
pub async fn cmd_workdir_mkdir(app: AppHandle, rel: String) -> Result<(), String> {
    let Some(root) = workdir_root(&app) else { return Err("未绑定工作目录".into()) };
    let p = resolve_rel(&root, &rel)?;
    std::fs::create_dir_all(&p).map_err(|e| format!("mkdir: {e}"))
}

#[tauri::command]
pub async fn cmd_workdir_move(app: AppHandle, from: String, to: String) -> Result<(), String> {
    let Some(root) = workdir_root(&app) else { return Err("未绑定工作目录".into()) };
    let src = resolve_rel(&root, &from)?;
    let dst = resolve_rel(&root, &to)?;
    if let Some(parent) = dst.parent() { let _ = std::fs::create_dir_all(parent); }
    std::fs::rename(&src, &dst).map_err(|e| format!("move: {e}"))
}
```

- [ ] **Step 2: 注册命令**（`lib.rs` 的 `generate_handler![... ]` 里，`workdir::cmd_workdir_remove,` 之后加）

```rust
            workdir::cmd_workdir_mkdir,
            workdir::cmd_workdir_move,
```

- [ ] **Step 3: 契约默认值**（`platform.js` 的 `fs` 对象里，`remove:` 之后加）

```js
      mkdir: () => Promise.resolve(false),      // (relPath) → Promise<bool>
      move: () => Promise.resolve(false),       // (fromRel, toRel) → Promise<bool>
```

- [ ] **Step 4: 桌面实现**（`platform-desktop.js` 的 `platform.fs` 里，`remove` 之后加）

```js
    async mkdir(relPath) {
      try { await invoke('cmd_workdir_mkdir', { rel: relPath }); return true; }
      catch (e) { console.warn('workdir_mkdir fail', e); return false; }
    },
    async move(fromRel, toRel) {
      try { await invoke('cmd_workdir_move', { from: fromRel, to: toRel }); return true; }
      catch (e) { console.warn('workdir_move fail', e); return false; }
    },
```

- [ ] **Step 5: 验证编译**

Run: `cd desktop/src-tauri && cargo check` → Expected: 通过（无 error）。
Run: `node --check shared/js/platform.js && node --check shared/js/platform-desktop.js` → Expected: OK。

- [ ] **Step 6: 提交**

```bash
git add desktop/src-tauri/src/workdir.rs desktop/src-tauri/src/lib.rs shared/js/platform.js shared/js/platform-desktop.js
git commit -m "feat(fs): 平台工作目录新增 mkdir / move 命令"
```

---

## Task 2: 回收站纯逻辑 trash-core（TDD）

**Files:**
- Create: `shared/js/trash-core.js`
- Test: `test/trash-core.test.js`

**Interfaces:**
- Produces（`window.trashCore` / `module.exports`）：
  - `trashName(uid, origName) → string`：回收站内存放名 = `${uid}__${origName}`。
  - `restoreTarget(originalPath, existingPathsSet) → string`：原路径被占用则在扩展名前加 `-1/-2…`。
  - `isExpired(deletedAt, now, days=30) → bool`。
  - `partitionExpired(index, now, days=30) → { expired: entry[], kept: entry[] }`。

- [ ] **Step 1: 写失败测试** `test/trash-core.test.js`

```js
const t = require('../shared/js/trash-core.js');
let p = 0, f = 0; const ck = (n, c) => { c ? (p++, console.log('✓', n)) : (f++, console.log('✗ FAIL', n)); };

ck('trashName 拼接', t.trashName('ab12', '笔记.md') === 'ab12__笔记.md');
ck('restoreTarget 原路径空闲直接用', t.restoreTarget('工作/a.md', new Set()) === '工作/a.md');
ck('restoreTarget 冲突加序号', t.restoreTarget('工作/a.md', new Set(['工作/a.md'])) === '工作/a-1.md');
ck('restoreTarget 连续冲突', t.restoreTarget('工作/a.md', new Set(['工作/a.md','工作/a-1.md'])) === '工作/a-2.md');
ck('restoreTarget 无扩展名(目录)冲突', t.restoreTarget('工作', new Set(['工作'])) === '工作-1');
const DAY = 86400000;
ck('isExpired 未过期', t.isExpired(1000, 1000 + 29 * DAY) === false);
ck('isExpired 刚过期', t.isExpired(1000, 1000 + 31 * DAY) === true);
const idx = [{ deletedAt: 0 }, { deletedAt: 100 * DAY }];
const part = t.partitionExpired(idx, 40 * DAY);
ck('partitionExpired 分区', part.expired.length === 1 && part.kept.length === 1 && part.kept[0].deletedAt === 100 * DAY);

console.log(`\n=== ${p} passed, ${f} failed ===`); process.exit(f ? 1 : 0);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/trash-core.test.js` → Expected: 报错（模块不存在）。

- [ ] **Step 3: 实现** `shared/js/trash-core.js`

```js
// 回收站纯逻辑：无 fs / 无 DOM，浏览器与 Node 双可用，便于离线测试。
(function (root) {
  const DAY = 86400000;
  function trashName(uid, origName) { return String(uid) + '__' + String(origName); }
  // 原路径被占用时，在扩展名之前插入 -N（无扩展名/目录则直接追加 -N）
  function restoreTarget(originalPath, existingPathsSet) {
    const has = (p) => existingPathsSet && existingPathsSet.has(p);
    if (!has(originalPath)) return originalPath;
    const slash = originalPath.lastIndexOf('/');
    const dir = slash >= 0 ? originalPath.slice(0, slash + 1) : '';
    const base = slash >= 0 ? originalPath.slice(slash + 1) : originalPath;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let n = 1, cand;
    do { cand = dir + stem + '-' + n + ext; n++; } while (has(cand));
    return cand;
  }
  function isExpired(deletedAt, now, days) { days = days || 30; return (now - (deletedAt || 0)) > days * DAY; }
  function partitionExpired(index, now, days) {
    const expired = [], kept = [];
    for (const e of (index || [])) (isExpired(e.deletedAt, now, days) ? expired : kept).push(e);
    return { expired, kept };
  }
  const api = { trashName, restoreTarget, isExpired, partitionExpired, DAY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.trashCore = api;
})(typeof window !== 'undefined' ? window : null);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/trash-core.test.js` → Expected: `8 passed, 0 failed`。

- [ ] **Step 5: 提交**

```bash
git add shared/js/trash-core.js test/trash-core.test.js
git commit -m "feat(trash): 回收站纯逻辑 trash-core + 测试"
```

---

## Task 3: 导入决策纯逻辑 import-plan（TDD）

**Files:**
- Create: `shared/js/import-plan.js`
- Test: `test/import-plan.test.js`

**Interfaces:**
- Produces（`window.importPlan` / `module.exports`）：
  - `planImport({entries, loadedByPath}) → { toRead: entry[] }`：
    - 排除 `回收站/` 下与 `_` 前缀的文件、目录项；
    - 对每个笔记/画板文件：若 `loadedByPath[path]` 不存在（应用尚未载入该路径）→ **必读**；若已载入且 `entry.mtime === loadedByPath[path].mtime` → 跳过（提速）；否则（mtime 变了）→ 读。

- [ ] **Step 1: 写失败测试** `test/import-plan.test.js`

```js
const { planImport } = require('../shared/js/import-plan.js');
let p = 0, f = 0; const ck = (n, c) => { c ? (p++, console.log('✓', n)) : (f++, console.log('✗ FAIL', n)); };
const paths = (r) => r.toRead.map(e => e.path).sort();

const entries = [
  { path: '工作/a.md', dir: false, mtime: 100 },
  { path: '工作/b.md', dir: false, mtime: 200 },
  { path: '回收站/x.md', dir: false, mtime: 300 },
  { path: '_assets/i.png', dir: false, mtime: 300 },
  { path: '工作', dir: true, mtime: 0 },
];
// a 已载入且 mtime 相同 → 跳过；b 未载入 → 必读
let r = planImport({ entries, loadedByPath: { '工作/a.md': { mtime: 100 } } });
ck('未载入的 b 必读', paths(r).includes('工作/b.md'));
ck('已载入未变的 a 跳过', !paths(r).includes('工作/a.md'));
ck('回收站文件被排除', !paths(r).includes('回收站/x.md'));
ck('下划线资产被排除', !paths(r).includes('_assets/i.png'));
ck('目录项被排除', r.toRead.every(e => !e.dir));
// a 已载入但 mtime 变了 → 读
r = planImport({ entries, loadedByPath: { '工作/a.md': { mtime: 99 } } });
ck('已载入但 mtime 变的 a 要读', paths(r).includes('工作/a.md'));
// 关键回归：外部拷入旧 mtime 文件，未载入 → 必读（修复 bug）
r = planImport({ entries: [{ path: '旧/c.md', dir: false, mtime: 1 }], loadedByPath: {} });
ck('旧 mtime 未载入文件必读', paths(r).includes('旧/c.md'));

console.log(`\n=== ${p} passed, ${f} failed ===`); process.exit(f ? 1 : 0);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/import-plan.test.js` → Expected: 报错（模块不存在）。

- [ ] **Step 3: 实现** `shared/js/import-plan.js`

```js
// 导入决策纯逻辑：决定哪些磁盘文件需要读取解析。核心原则：应用尚未载入的文件一律读取，
// 绝不因 mtime 早于某阈值而跳过（修复"磁盘有文件却不导入"）。双导出，便于离线测试。
(function (root) {
  const NOTE_RE = /\.(md|markdown|excalidraw)$/i;
  function planImport({ entries, loadedByPath }) {
    loadedByPath = loadedByPath || {};
    const toRead = [];
    for (const e of (entries || [])) {
      if (e.dir) continue;
      if (!NOTE_RE.test(e.path)) continue;
      if (e.path.startsWith('_') || e.path.startsWith('回收站/')) continue;
      const loaded = loadedByPath[e.path];
      if (!loaded) { toRead.push(e); continue; }                 // 未载入 → 必读
      if ((e.mtime || 0) !== (loaded.mtime || 0)) toRead.push(e); // mtime 变 → 读；否则跳过
    }
    return { toRead };
  }
  const api = { planImport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.importPlan = api;
})(typeof window !== 'undefined' ? window : null);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/import-plan.test.js` → Expected: `7 passed, 0 failed`。

- [ ] **Step 5: 提交**

```bash
git add shared/js/import-plan.js test/import-plan.test.js
git commit -m "feat(import): 导入决策纯逻辑 import-plan(不漏未载入文件) + 测试"
```

---

## Task 4: 改造 workdirImportAll 用 import-plan + 排除回收站

**Files:**
- Modify: `shared/app.js`（`workdirImportAll`：去掉 `since`/`skipUnchanged`/`maxMtime`/`lastImportAt` 增量跳过；改用 `importPlan.planImport`）
- Modify: `shared/app.js`（`initWorkDir` 调用去掉 `{ since }` 参数）
- Modify: `shared/index.html`（在 `app.js` 之前加载 `import-plan.js`）

**Interfaces:**
- Consumes: `window.importPlan.planImport`（Task 3）。
- Produces: `workdirImportAll(silent)` 全量可靠导入，`回收站/` 被跳过。

- [ ] **Step 1: index.html 加载脚本**（`<script src="app.js">` 之前）

```html
<script src="js/trash-core.js"></script>
<script src="js/import-plan.js"></script>
```

- [ ] **Step 2: 改 `workdirImportAll`**：删除 `const since = ...`、`maxMtime`、`skipUnchanged`、两处 `if (skipUnchanged(f)) {...}`、结尾 `_workdirCfg.lastImportAt = maxMtime;`。在取得 `entries` 后，用 planImport 过滤要读的笔记/画板文件：

```js
    const entries = await fs.list();
    // 已载入的路径 → mtime，用于跳过未变文件的重复解析（但绝不跳过未载入的文件）
    const loadedByPath = {};
    for (const n of notes) if (n._srcPath) loadedByPath[n._srcPath] = { mtime: n._srcMtime || 0 };
    const { toRead } = importPlan.planImport({ entries, loadedByPath });
    const mdFiles = toRead.filter(e => /\.(md|markdown)$/i.test(e.path));
    const drawFiles = toRead.filter(e => /\.excalidraw$/i.test(e.path));
    const assetFiles = entries.filter(e => !e.dir && /^_assets\//i.test(e.path));
```

  说明：`n._srcPath`/`n._srcMtime` 是导入时给每条笔记打的来源标记（下一步补），用于"未变则跳过重复解析"。首次没有标记 → 全部读，可靠。

- [ ] **Step 3: 导入笔记时记录来源标记**：在 md/draw 两个导入循环里，构造/更新 note 后加：

```js
      note._srcPath = f.path;
      note._srcMtime = f.mtime || 0;
```

  （赋值到 push 或 Object.assign 的对象上；`_src*` 字段不写盘——`noteToMarkdown` 不含它们、`saveData` 存了也无妨。）

- [ ] **Step 4: initWorkDir 去掉增量参数**

```js
      await workdirImportAll(true);
```

- [ ] **Step 5: 验证**

Run: `node --check shared/app.js` → Expected: OK。
（导入逻辑的纯决策已在 Task 3 覆盖；此处为接线，桌面端由用户实测"外部拷入的旧文件能导入"。）

- [ ] **Step 6: 提交**

```bash
git add shared/app.js shared/index.html
git commit -m "fix(import): 全量可靠导入(不漏未载入文件)+排除回收站，移除按mtime跳过"
```

---

## Task 5: 回收站操作层 trash.js

**Files:**
- Create: `shared/js/trash.js`
- Modify: `shared/index.html`（加载 `trash.js`，在 `app.js` 之后、`assistant.js` 之前均可，需在 `trash-core.js` 之后）

**Interfaces:**
- Consumes: `fsApi()`、`window.trashCore`、`WORKDIR_META` 同级的 `_marginote/trash.json`。
- Produces（`window.trash`）：
  - `loadTrashIndex() → Promise<entry[]>`、`saveTrashIndex(arr) → Promise<void>`。
  - `moveToTrash({ path, type, name }) → Promise<entry|null>`：把 `path`（文件或目录）移入 `回收站/<uid>__<name>`，写索引，返回 entry `{ trashPath, originalPath, type, name, deletedAt }`。
  - `restoreFromTrash(trashPath, existingPathsSet) → Promise<string|null>`：移回（用 `trashCore.restoreTarget` 定目标），从索引移除，返回目标路径。
  - `purgeExpired(now) → Promise<number>`：删过期项磁盘 + 索引，返回清理数。
  - `permanentDelete(trashPath) → Promise<void>`。

- [ ] **Step 1: 实现** `shared/js/trash.js`

```js
// 回收站操作（桌面）：把删除的文件/目录移入 回收站/，索引存 _marginote/trash.json，
// 支持恢复、彻底删、30 天清理。依赖 fsApi() 与 window.trashCore。
(function () {
  const TRASH_DIR = '回收站';
  const TRASH_INDEX = '_marginote/trash.json';
  let _uidSeq = 0;
  function _uid() { _uidSeq++; return (typeof uid === 'function' ? uid() : 't' + Date.now().toString(36)) + '-' + _uidSeq; }

  async function loadTrashIndex() {
    const fs = fsApi(); if (!fs) return [];
    try { const t = await fs.readText(TRASH_INDEX); const a = t ? JSON.parse(t) : []; return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  async function saveTrashIndex(arr) {
    const fs = fsApi(); if (!fs) return;
    try { await fs.writeText(TRASH_INDEX, JSON.stringify(arr || [], null, 2)); } catch {}
  }
  async function moveToTrash({ path, type, name }) {
    const fs = fsApi(); if (!fs || !path) return null;
    const store = TRASH_DIR + '/' + window.trashCore.trashName(_uid(), name || (path.split('/').pop() || 'item'));
    const ok = await fs.move(path, store);
    if (!ok) return null;
    const entry = { trashPath: store, originalPath: path, type: type || 'note', name: name || path.split('/').pop(), deletedAt: (typeof nowMs === 'function' ? nowMs() : new Date().getTime()) };
    const idx = await loadTrashIndex(); idx.push(entry); await saveTrashIndex(idx);
    return entry;
  }
  async function restoreFromTrash(trashPath, existingPathsSet) {
    const fs = fsApi(); if (!fs) return null;
    const idx = await loadTrashIndex();
    const e = idx.find(x => x.trashPath === trashPath); if (!e) return null;
    const target = window.trashCore.restoreTarget(e.originalPath, existingPathsSet || new Set());
    const ok = await fs.move(trashPath, target); if (!ok) return null;
    await saveTrashIndex(idx.filter(x => x.trashPath !== trashPath));
    return target;
  }
  async function permanentDelete(trashPath) {
    const fs = fsApi(); if (!fs) return;
    try { await fs.remove(trashPath); } catch {}
    const idx = await loadTrashIndex();
    await saveTrashIndex(idx.filter(x => x.trashPath !== trashPath));
  }
  async function purgeExpired(now) {
    const fs = fsApi(); if (!fs) return 0;
    const idx = await loadTrashIndex();
    const { expired, kept } = window.trashCore.partitionExpired(idx, now, 30);
    for (const e of expired) { try { await fs.remove(e.trashPath); } catch {} }
    if (expired.length) await saveTrashIndex(kept);
    return expired.length;
  }
  window.trash = { loadTrashIndex, saveTrashIndex, moveToTrash, restoreFromTrash, permanentDelete, purgeExpired, TRASH_DIR, TRASH_INDEX };
})();
```

  说明：需要一个 `nowMs()`（毫秒时间）辅助——若 app.js 无此函数，本步在 trash.js 内用 `new Date().getTime()` 兜底（已写）。

- [ ] **Step 2: index.html 加载**（`app.js` 之后加）

```html
<script src="js/trash.js"></script>
```

- [ ] **Step 3: 验证**

Run: `node --check shared/js/trash.js` → Expected: OK。

- [ ] **Step 4: 提交**

```bash
git add shared/js/trash.js shared/index.html
git commit -m "feat(trash): 回收站操作层(移入/恢复/彻底删/30天清理)"
```

---

## Task 6: 写穿层 fileops.js（笔记/待办/笔记本/文件夹）

**Files:**
- Create: `shared/js/fileops.js`
- Modify: `shared/index.html`（加载，在 `app.js` 与 `trash.js` 之后）

**Interfaces:**
- Consumes: `fsApi()`、`window.trash`、`noteRelPath/drawingRelPath`、`safeName`、`TODO_DIR`、`noteToMarkdown/drawingToFile/todoToMarkdown`、全局数组与 `saveData()`。
- Produces（`window.fileops`，全部 async，桌面启用时用；返回后调用方再 `renderX`）：
  - `writeNoteFile(note) → Promise<void>`：写单篇笔记文件（画板写 .excalidraw），并更新 `note._srcPath/_srcMtime`；若路径较上次变化（`note._srcPath` 不等新路径）→ 先把旧文件移入回收站前的普通 `fs.move` 到新路径（移动而非删旧再写）。
  - `deleteNoteToTrash(note) → Promise<void>`：把该笔记文件移入回收站。
  - `deleteNotebookToTrash(nbName) → Promise<void>`：把笔记本目录移入回收站。
  - `deleteFolderToTrash(nbName, folderName) → Promise<void>`。
  - `deleteTodoToTrash(todo) → Promise<void>`。
  - `mkdirNotebook(nbName) / mkdirFolder(nbName, folderName) → Promise<void>`：立即建目录。
  - `renameDir(fromRel, toRel) → Promise<void>`。

- [ ] **Step 1: 实现** `shared/js/fileops.js`（核心骨架，函数体用现有 helper）

```js
// 写穿层（桌面）：所有结构性文件操作在此统一执行——先改磁盘，再由调用方改内存/渲染。
// 仅在 isDesktopContext() 且已绑定工作目录时使用。
(function () {
  const A = () => (typeof fsApi === 'function' ? fsApi() : null);
  function noteRel(n) { return n.type === 'drawing' ? drawingRelPath(n) : noteRelPath(n); }
  function noteBody(n) { return n.type === 'drawing' ? drawingToFile(n) : noteToMarkdown(n, { mode: 'inline' }); }

  async function writeNoteFile(note) {
    const fs = A(); if (!fs) return;
    const rel = noteRel(note);
    if (note._srcPath && note._srcPath !== rel) { try { await fs.move(note._srcPath, rel); } catch {} }
    await fs.writeText(rel, noteBody(note));
    note._srcPath = rel; note._srcMtime = (typeof nowMs === 'function' ? nowMs() : new Date().getTime());
  }
  async function deleteNoteToTrash(note) {
    const fs = A(); if (!fs) return;
    const rel = note._srcPath || noteRel(note);
    await window.trash.moveToTrash({ path: rel, type: 'note', name: rel.split('/').pop() });
  }
  async function deleteNotebookToTrash(nbName) {
    if (!A()) return;
    await window.trash.moveToTrash({ path: nbName, type: 'notebook', name: nbName });
  }
  async function deleteFolderToTrash(nbName, folderName) {
    if (!A()) return;
    await window.trash.moveToTrash({ path: nbName + '/' + folderName, type: 'folder', name: folderName });
  }
  async function deleteTodoToTrash(todo) {
    const fs = A(); if (!fs) return;
    const rel = todo._srcPath || (TODO_DIR + '/' + safeName(todo.text || 'todo') + '.md');
    await window.trash.moveToTrash({ path: rel, type: 'todo', name: rel.split('/').pop() });
  }
  async function mkdirNotebook(nbName) { const fs = A(); if (fs) await fs.mkdir(nbName); }
  async function mkdirFolder(nbName, folderName) { const fs = A(); if (fs) await fs.mkdir(nbName + '/' + folderName); }
  async function renameDir(fromRel, toRel) { const fs = A(); if (fs) await fs.move(fromRel, toRel); }

  window.fileops = { writeNoteFile, deleteNoteToTrash, deleteNotebookToTrash, deleteFolderToTrash, deleteTodoToTrash, mkdirNotebook, mkdirFolder, renameDir };
})();
```

  注意：`noteRelPath(n)` 现有实现在不传 `usedPaths` 时也应能算出稳定路径（执行者需确认；若强制需要 usedPaths，则传 `new Set()`）。待办按 text 命名会因重名碰撞——本层删除优先用 `todo._srcPath`；写待办文件的去重仍走批量 `workdirWriteAll` 或后续任务补 `_srcPath`。

- [ ] **Step 2: index.html 加载**

```html
<script src="js/fileops.js"></script>
```

- [ ] **Step 3: 验证**

Run: `node --check shared/js/fileops.js` → Expected: OK。

- [ ] **Step 4: 提交**

```bash
git add shared/js/fileops.js shared/index.html
git commit -m "feat(fileops): 桌面写穿层(笔记/待办/笔记本/文件夹 建改移删→磁盘)"
```

---

## Task 7: UI 删除/移动/重命名接入 fileops（笔记本/文件夹/笔记）

**Files:**
- Modify: `shared/app.js`（`deleteNotebook` @1288、`deleteFolder` @1348、笔记删除/移动/重命名处、笔记本重命名处）

**Interfaces:**
- Consumes: `window.fileops`。桌面绑定工作目录时，先 `await fileops.xxx()` 再改内存；非桌面走原逻辑。

- [ ] **Step 1: deleteNotebook 接入**（在其 showModal 确认回调中，删除内存前加）

```js
    // 桌面：把磁盘上的笔记本目录移入回收站（连同其中所有文件），再改内存
    if (typeof isDesktopContext === 'function' && isDesktopContext() && _workdirCfg.enabled && window.fileops) {
      try { await window.fileops.deleteNotebookToTrash(nb.name); } catch (e) { logError(e, 'fileops-del-nb'); }
    }
```
  （确认回调需为 `async`。）

- [ ] **Step 2: deleteFolder 接入**（类似，调用 `fileops.deleteFolderToTrash(nb.name, folder.name)`；需要该文件夹所属笔记本名——按现有 folder→notebook 关系取得）。

- [ ] **Step 3: 笔记删除接入**：定位单篇笔记删除处（软删/永久删），桌面时改为 `await fileops.deleteNoteToTrash(note)`，不再依赖 `workdirWriteAll` 的 deleted 循环。

- [ ] **Step 4: 移动/重命名接入**：移动笔记（改 notebookId/folderId）后 `await fileops.writeNoteFile(note)`（内部处理旧路径移动）；重命名笔记本 → `await fileops.renameDir(oldName, newName)`；重命名文件夹类似。

- [ ] **Step 5: 验证**

Run: `node --check shared/app.js` → Expected: OK。桌面端由用户实测：删/移/改后磁盘即时一致、删笔记本目录进回收站。

- [ ] **Step 6: 提交**

```bash
git add shared/app.js
git commit -m "feat: UI 删除/移动/重命名 笔记与笔记本 直接写穿到磁盘/回收站"
```

---

## Task 8: 新建笔记本/文件夹立即建目录 + 空目录清理豁免当前笔记本

**Files:**
- Modify: `shared/app.js`（新建笔记本/文件夹处调用 `fileops.mkdirNotebook/mkdirFolder`；`workdirWriteAll` 内空目录清理加"对应当前笔记本/文件夹则豁免"）

- [ ] **Step 1: 新建笔记本/文件夹接入**（创建内存对象后，桌面时 `await fileops.mkdirNotebook(name)` / `mkdirFolder(nbName, name)`）。

- [ ] **Step 2: 空目录清理豁免**（`workdirWriteAll` 的 emptyDirs 过滤里，排除仍对应当前笔记本/文件夹名的目录）

```js
      const nbDirNames = new Set(notebooks.map(n => n.name));
      const emptyDirs = after.filter(e => e.dir).map(e => e.path)
        .filter(p => p && !p.startsWith('_') && p !== TODO_DIR && !p.startsWith(TODO_DIR + '/')
                     && p !== window.trash.TRASH_DIR && !p.startsWith(window.trash.TRASH_DIR + '/')
                     && !nbDirNames.has(p)                    // 顶层空笔记本目录豁免
                     && !dirsWithFiles.has(p))
        .sort((a, b) => b.length - a.length);
```

- [ ] **Step 3: 验证** `node --check shared/app.js` → OK。桌面端用户实测：新建空笔记本磁盘出现目录且不被清掉。

- [ ] **Step 4: 提交**

```bash
git add shared/app.js
git commit -m "feat: 新建笔记本/文件夹立即建目录 + 空目录清理豁免当前笔记本(与回收站)"
```

---

## Task 9: AI 写工具接入 fileops

**Files:**
- Modify: `shared/js/assistant.js`（`ASSISTANT_TOOLS` 的 create_note/quick_note/delete_note/delete_notebook/move_note/rename_notebook/create_notebook/create_folder 等 run 内，桌面时经 fileops 落盘）

- [ ] **Step 1:** 每个写工具在改内存后，桌面时补一次对应 fileops 调用（新建/改→`writeNoteFile`；删→`deleteNoteToTrash`/`deleteNotebookToTrash`；建本→`mkdirNotebook`；建夹→`mkdirFolder`；重命名本→`renameDir`）。保留末尾 `workdirWriteAll(true)` 作兜底同步（现已在主循环 WRITE_TOOLS 后触发）。

- [ ] **Step 2: 验证** `node --check shared/js/assistant.js` → OK。

- [ ] **Step 3: 提交**

```bash
git add shared/js/assistant.js
git commit -m "feat: AI 写工具经 fileops 直接落盘/进回收站"
```

---

## Task 10: 正文编辑防抖写穿

**Files:**
- Modify: `shared/app.js`（编辑器 content input 的保存路径）

- [ ] **Step 1:** 在正文/标题变更的 `saveData()` 附近，桌面绑定工作目录时对**当前笔记**做防抖 `fileops.writeNoteFile(currentNote)`（~800ms）；并在切换笔记/失焦/关闭前 flush（立即写）。可用一个 `_noteWriteTimer` + `flushNoteWrite()`。

```js
let _noteWriteTimer = null;
function scheduleNoteWrite(note) {
  if (!(isDesktopContext() && _workdirCfg.enabled && window.fileops && note)) return;
  clearTimeout(_noteWriteTimer);
  _noteWriteTimer = setTimeout(() => { window.fileops.writeNoteFile(note).catch(e => logError(e, 'note-write')); }, 800);
}
function flushNoteWrite() { if (_noteWriteTimer) { clearTimeout(_noteWriteTimer); _noteWriteTimer = null; if (currentNote && isDesktopContext() && _workdirCfg.enabled && window.fileops) window.fileops.writeNoteFile(currentNote).catch(() => {}); } }
```
  在 content input 的 input 事件里调 `scheduleNoteWrite(currentNote)`；切换笔记/关闭编辑器/blur 里调 `flushNoteWrite()`。

- [ ] **Step 2: 验证** `node --check shared/app.js` → OK。桌面端用户实测：编辑正文 ~1s 后磁盘文件更新；切换笔记不丢最后编辑。

- [ ] **Step 3: 提交**

```bash
git add shared/app.js
git commit -m "feat: 正文编辑防抖写穿到磁盘 + 切换/失焦前 flush"
```

---

## Task 11: 强制工作目录 + 首次迁移

**Files:**
- Modify: `shared/app.js`（`init` 启动编排：桌面且未绑定 → 强制选目录；迁移 localStorage → 磁盘）
- Modify: `shared/index.html`（强制选目录的遮罩 UI，可复用现有 pickWorkDir 按钮/文案）

**Interfaces:**
- Consumes: `pickWorkDir()`、`workdirWriteAll()`、`workdirImportAll()`。

- [ ] **Step 1: 迁移函数**

```js
async function migrateLocalToWorkdir() {
  // 首次绑定工作目录：把当前 localStorage 的现有数据全量写入磁盘（迁移前不清 localStorage，作兜底）
  if (notes.length || todos.length || notebooks.length) {
    await workdirWriteAll(true);
  }
}
```

- [ ] **Step 2: 启动强制绑定**（`init` 中，首屏渲染后、全量校准前）

```js
  if (isDesktopContext()) {
    if (!(_workdirCfg.enabled && await fsApi().hasDir())) {
      await requireWorkdirSetup();   // 显示不可跳过的选择遮罩，内部循环直到 pickWorkDir 成功
      await migrateLocalToWorkdir();
    }
  }
```
  `requireWorkdirSetup()`：显示遮罩（复用设置里的工作目录选择 UI 或新 DOM），点击"选择目录"→ `await pickWorkDir()`；成功（`_workdirCfg.enabled && hasDir()`）才移除遮罩。

- [ ] **Step 3: 验证** `node --check shared/app.js` → OK。桌面端用户实测：干净环境首启必须先选目录；已有数据迁移到目录。

- [ ] **Step 4: 提交**

```bash
git add shared/app.js shared/index.html
git commit -m "feat: 桌面版强制工作目录 + 首次 localStorage 数据迁移到磁盘"
```

---

## Task 12: 启动编排 + 30 天清理接入

**Files:**
- Modify: `shared/app.js`（`init` / `initWorkDir`：绑定后全量校准 + `trash.purgeExpired`）

- [ ] **Step 1:** 在工作目录就绪后（`init` 内或 `initWorkDir`）：

```js
  await workdirImportAll(true);                 // 全量可靠校准（磁盘为准）
  renderNotebooks(); renderTagFilters(); renderNotesList();
  try { if (window.trash) await window.trash.purgeExpired(typeof nowMs === 'function' ? nowMs() : new Date().getTime()); } catch (e) { logError(e, 'trash-purge'); }
```

- [ ] **Step 2: 验证** `node --check shared/app.js` → OK。

- [ ] **Step 3: 提交**

```bash
git add shared/app.js
git commit -m "feat: 启动全量校准 + 回收站 30 天清理"
```

---

## Task 13: 回收站视图 UI

**Files:**
- Modify: `shared/index.html`（新增「回收站」入口 + 列表 DOM + 样式）
- Modify: `shared/app.js`（渲染回收站列表、恢复/彻底删按钮处理）

**Interfaces:**
- Consumes: `window.trash`（loadTrashIndex/restoreFromTrash/permanentDelete）、`trashCore`。

- [ ] **Step 1:** 加入口（如侧栏底部或设置里）与容器 `#trashView`。渲染函数：

```js
async function renderTrashView() {
  const box = document.getElementById('trashList'); if (!box) return;
  const idx = await window.trash.loadTrashIndex();
  const now = (typeof nowMs === 'function' ? nowMs() : new Date().getTime());
  if (!idx.length) { box.innerHTML = '<div class="trash-empty">回收站为空</div>'; return; }
  box.innerHTML = idx.map(e => {
    const days = Math.max(0, 30 - Math.floor((now - (e.deletedAt || 0)) / 86400000));
    return `<div class="trash-item" data-tp="${escapeHtml(e.trashPath)}">
      <span class="trash-name">${escapeHtml(e.name || '')}</span>
      <span class="trash-meta">${formatFullDate(e.deletedAt)} · 剩 ${days} 天</span>
      <button data-act="restore">恢复</button><button data-act="purge">彻底删除</button></div>`;
  }).join('');
  // 绑定：restore → 收集当前磁盘占用路径集合(fs.list) → trash.restoreFromTrash → workdirImportAll(true) → 重渲染
  // purge → showModal 确认 → trash.permanentDelete → 重渲染
}
```

- [ ] **Step 2:** 恢复按钮：`existing = new Set((await fsApi().list()).filter(e=>!e.dir).map(e=>e.path))`；`await window.trash.restoreFromTrash(tp, existing)`；`await workdirImportAll(true)`；`renderTrashView(); renderNotesList();`。彻底删按钮：`showModal('彻底删除？','此操作不可恢复', async()=>{ await window.trash.permanentDelete(tp); renderTrashView(); })`。

- [ ] **Step 3: 验证** `node --check shared/app.js` → OK。桌面端用户实测：删项出现在回收站、能恢复、能彻底删。

- [ ] **Step 4: 提交**

```bash
git add shared/index.html shared/app.js
git commit -m "feat: 软件内回收站视图(浏览/恢复/彻底删)"
```

---

## Task 14: 收尾集成校验 + 文档

**Files:**
- Modify: `CHANGELOG.md`（记录本次工作目录重构）

- [ ] **Step 1:** 跑全部离线测试：`node test/trash-core.test.js && node test/import-plan.test.js` → 全过。
- [ ] **Step 2:** `node --check` 所有改过的 JS；`cd desktop/src-tauri && cargo check` 通过。
- [ ] **Step 3:** 写 CHANGELOG 段落（工作目录为唯一数据源、直接文件操作、回收站 30 天、导入修复）。
- [ ] **Step 4:** 桌面端用户完整验收清单（见下）。
- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "docs: v1.2.x 工作目录重构 CHANGELOG + 收尾"
```

---

## 桌面端用户验收清单（本机跑不了 exe，需用户实测）

1. 干净环境首启 → 必须先选工作目录；选后能正常用。
2. 已有数据升级 → 首启迁移，笔记/待办出现在所选目录的真实文件里。
3. 外部往目录拷入一个 `.md`（旧修改时间）→ 软件刷新能导入（修复 bug）。
4. 删除笔记 → 磁盘文件进 `回收站/`，活跃列表消失。
5. 删除笔记本 → 磁盘上整个笔记本目录进 `回收站/`，不再残留。
6. 移动笔记到别的笔记本 → 磁盘文件真的换了目录，旧路径无残留。
7. 重命名笔记本 → 磁盘目录名跟着变。
8. 编辑正文 ~1s → 磁盘文件更新；切换笔记不丢最后编辑。
9. 回收站视图能恢复、能彻底删；删除超 30 天的项重启后自动消失（可临时改索引 deletedAt 验证）。

## Self-Review 覆盖对照

- Spec §3 存储模型 → Task 4/11/12。§4 直接操作 → Task 6/7/8/9/10。§5 回收站 → Task 2/5/13 + 30 天(Task 12)。§6 导入修复 → Task 3/4。§7 迁移 → Task 11。§8 组件边界 → 文件结构。§9 测试 → Task 2/3/14。空目录豁免（spec §4 一致性）→ Task 8。
