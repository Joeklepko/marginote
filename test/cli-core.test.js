const core = require('../shared/js/cli-core.js');

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
    rename_notebook: { run: async args => { calls.push(['rename_notebook', args]); return { id: args.notebookId }; } }
  };
  const handler = core.createHandler({
    tools,
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

  await handler('rename_notebook_cli', { notebookRef: 'work', newName: '新工作' });
  check('笔记本引用可按 ID 精确解析', calls.at(-1)[1].notebookId === 'work');

  let rejected = false;
  try { await handler('optimize_text', { text: 'x' }); } catch { rejected = true; }
  check('任意工具调用受白名单限制', rejected);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
