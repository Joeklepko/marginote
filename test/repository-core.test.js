const core = require('../shared/js/repository-core.js');
const assert = require('node:assert/strict');

(async () => {
  let state = { notebooks: [], folders: [], notes: [{ id: 'n1', title: '旧', content: '' }], todos: [] };
  let persistCount = 0;
  const commits = [];
  const rollbacks = [];
  const repo = core.createRepository({
    readState: () => state,
    replaceState: next => { state = next; },
    persist: async () => { persistCount += 1; },
    onCommit: changeSet => commits.push(changeSet),
    onRollback: changeSet => rollbacks.push(changeSet)
  });

  const committed = await repo.run('test:update', async () => {
    state.notes[0].title = '新';
    state.notes[0].content = '正文';
    return 'ok';
  });
  assert.equal(committed.value, 'ok');
  assert.equal(persistCount, 1);
  assert.equal(committed.changeSet.status, 'committed');
  assert.deepEqual(committed.changeSet.changes[0].fields, ['content', 'title']);
  assert.equal(commits.length, 1);

  await assert.rejects(repo.run('test:rollback', async () => {
    state.notes.push({ id: 'n2', title: '不应保留' });
    throw new Error('boom');
  }), /boom/);
  assert.equal(state.notes.some(note => note.id === 'n2'), false);
  assert.equal(persistCount, 1);
  assert.equal(rollbacks.at(-1).status, 'rolled_back');

  let failingState = { notebooks: [], folders: [], notes: [{ id: 'n1', title: '原始' }], todos: [] };
  const failingRepo = core.createRepository({
    readState: () => failingState,
    replaceState: next => { failingState = next; },
    persist: async () => { throw new Error('disk failed'); }
  });
  await assert.rejects(failingRepo.run('test:persist', async () => {
    failingState.notes[0].title = '不能提交';
  }), /disk failed/);
  assert.equal(failingState.notes[0].title, '原始');

  const order = [];
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const serialState = { notebooks: [], folders: [], notes: [], todos: [] };
  const serialRepo = core.createRepository({
    readState: () => serialState,
    replaceState: next => Object.assign(serialState, next),
    persist: async () => {}
  });
  const first = serialRepo.run('first', async () => { order.push('first:start'); await gate; order.push('first:end'); });
  const second = serialRepo.run('second', async () => { order.push('second'); });
  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
})();
