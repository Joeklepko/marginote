const core = require('../shared/js/cli-core.js');
const repositoryCore = require('../shared/js/repository-core.js');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log('✓', name); }
  else { failed++; console.error('✗ FAIL', name); }
}

(async () => {
  const calls = [];
  const tools = {
    search_notes: { run: async () => [
      { id: 'n1', title: '发布计划', notebookName: '工作', tags: ['发布'], starred: true },
      { id: 'n2', title: '购物', notebookName: '生活', tags: ['清单'], starred: false }
    ] },
    search_todos: { run: async () => [{ id: 't1', text: '发布 1.2.4' }] },
    update_note: { run: async args => { calls.push(['update_note', args]); return { id: args.id }; } },
    append_to_note: { run: async args => { calls.push(['append_to_note', args]); return { id: args.noteId }; } },
    add_tags: { run: async args => { calls.push(['add_tags', args]); return { id: args.noteId }; } },
    star_note: { run: async args => { calls.push(['star_note', args]); return { id: args.noteId }; } },
    rename_notebook: { run: async args => { calls.push(['rename_notebook', args]); return { id: args.notebookId }; } },
    delete_note: { run: async args => { calls.push(['delete_note', args]); return { id: args.id }; } }
  };
  const transactions = [];
  const handler = core.createHandler({
    tools,
    runTransaction: async (label, task) => { transactions.push(label); return await task(); },
    snapshot: () => ({ version: '1.2.4', notes: [{ id: 'n1' }], todos: [{ id: 't1', done: false }], notebooks: [{ id: 'work' }], workdir: 'D:/Notes' })
  });

  const status = await handler('status', {});
  check('status 返回共享数据统计', status.notes === 1 && status.activeTodos === 1 && status.workdir === 'D:/Notes');

  const filtered = await handler('list_notes', { notebookName: '工作', tags: ['发布'], starred: true });
  check('list_notes 支持笔记本、标签和收藏过滤', filtered.length === 1 && filtered[0].id === 'n1');

  const all = await handler('search_all', { query: '发布', limit: 10 });
  check('search_all 同时返回笔记和待办', all.notes.length === 2 && all.todos[0].id === 't1');

  await handler('update_note_cli', { id: 'n1', title: '新版', content: '补充', append: true, addTags: ['版本'], starred: true });
  check('复合更新依次复用已有写工具', calls.map(call => call[0]).join(',') === 'update_note,append_to_note,add_tags,star_note');
  check('CLI 复合更新只进入一个事务', transactions.filter(label => label === 'cli:update_note_cli').length === 1);

  await handler('rename_notebook_cli', { notebookRef: 'work', newName: '新工作' });
  check('笔记本引用可按 ID 精确解析', calls.at(-1)[1].notebookId === 'work');

  let rejected = false;
  try { await handler('optimize_text', { text: 'x' }); } catch { rejected = true; }
  check('任意工具调用受白名单限制', rejected);

  check('CLI 状态栏能描述笔记写入任务', core.describeCommand('create_note', { title: '会议纪要' }) === '新建笔记「会议纪要」');
  check('CLI 状态栏能描述搜索任务', core.describeCommand('search_all', { query: '发布计划' }) === '搜索笔记和待办「发布计划」');
  check('未知 CLI 工具有安全的回退描述', core.describeCommand('custom_tool', {}) === '执行 CLI 工具 custom_tool');

  let deleteRejected = false;
  try { await handler('delete_note', { id: 'n1' }); } catch { deleteRejected = true; }
  check('CLI 核心拒绝未经确认的高级删除调用', deleteRejected);
  await handler('delete_note', { id: 'n1', _confirmed: true });
  check('CLI 核心放行已显式确认的删除调用', calls.at(-1)[0] === 'delete_note' && calls.at(-1)[1]._confirmed === undefined);
  check('磁盘回收站删除不套用仅内存事务', !transactions.includes('cli:delete_note'));

  let atomicState = { notebooks: [{ id: 'work', name: '工作' }], folders: [], notes: [{ id: 'n1', title: '原始', content: '' }], todos: [] };
  const repo = repositoryCore.createRepository({
    readState: () => atomicState,
    replaceState: next => { atomicState = next; },
    persist: async () => {}
  });
  const atomicHandler = core.createHandler({
    tools: {
      update_note: { run: async args => { atomicState.notes[0].title = args.title; return { id: args.id }; } },
      append_to_note: { run: async () => { throw new Error('append failed'); } }
    },
    snapshot: () => atomicState,
    runTransaction: async (label, task) => (await repo.run(label, task)).value
  });
  let atomicRejected = false;
  try { await atomicHandler('update_note_cli', { id: 'n1', title: '不应保留', content: 'x', append: true }); }
  catch { atomicRejected = true; }
  check('CLI 复合更新中途失败会整体回滚', atomicRejected && atomicState.notes[0].title === '原始');

  let dryRunCalls = 0;
  const dryHandler = core.createHandler({
    tools: {
      create_note: { run: async () => { dryRunCalls++; return { id: 'unexpected' }; } },
      delete_note: { run: async () => { dryRunCalls++; return { id: 'unexpected' }; } }
    },
    snapshot: () => ({ notes: [], todos: [], notebooks: [] })
  });
  const dryCreate = await dryHandler('create_note', { title: '预演', content: '正文', _dryRun: true });
  check('dry-run 返回写入计划且不调用业务工具', dryCreate.dryRun === true && dryCreate.command === 'create_note' && dryRunCalls === 0);
  const dryDelete = await dryHandler('delete_note', { id: 'n1', _dryRun: true });
  check('dry-run 的删除计划不要求真正确认', dryDelete.dryRun === true && dryDelete.access === 'destructive' && dryRunCalls === 0);

  const firstFingerprint = core.requestFingerprint('create_note', { title: 'A', _confirmed: true });
  const sameFingerprint = core.requestFingerprint('create_note', { _dryRun: true, title: 'A' });
  const records = core.recordIdempotencyResult([], {
    requestId: 'req-1', fingerprint: firstFingerprint, data: { id: 'n1' }, completedAt: 1000
  }, { now: 1000, ttlMs: 5000 });
  check('幂等指纹忽略桥内部控制字段', firstFingerprint === sameFingerprint);
  check('幂等记录可复用同一请求结果', core.lookupIdempotencyRecord(records, 'req-1', firstFingerprint).kind === 'hit');
  check('相同请求 ID 不允许复用为不同操作', core.lookupIdempotencyRecord(records, 'req-1', core.requestFingerprint('create_note', { title: 'B' })).kind === 'conflict');

  const firstPage = await handler('list_notes', { paged: true, limit: 1 });
  const secondPage = await handler('list_notes', { paged: true, limit: 1, cursor: firstPage.nextCursor });
  check('笔记列表可使用不透明 cursor 分页', firstPage.items[0].id === 'n1' && firstPage.hasMore && secondPage.items[0].id === 'n2');
  let invalidCursorRejected = false;
  try { await handler('list_notes', { paged: true, cursor: 'bad' }); } catch { invalidCursorRejected = true; }
  check('无效 cursor 会明确拒绝', invalidCursorRejected);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
