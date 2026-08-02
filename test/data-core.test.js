const core = require('../shared/js/data-core.js');
const assert = require('node:assert/strict');

const valid = core.parsePersistedData(JSON.stringify({
  notebooks: [{ id: 'nb1' }], folders: [], notes: [{ id: 'n1' }], todos: [], images: { img1: { name: 'a.png' } }
}));
assert.equal(valid.ok, true);
assert.equal(valid.data.schemaVersion, 1);
assert.equal(valid.sourceSchemaVersion, 0);
assert.equal(valid.migrated, true);
assert.equal(valid.data.notes[0].id, 'n1');
assert.equal(valid.data.images.img1.name, 'a.png');

const malformed = core.parsePersistedData('{"notes":');
assert.equal(malformed.ok, false);
assert.match(malformed.issues[0], /JSON/);

const normalized = core.parsePersistedData(JSON.stringify({ notes: [{ id: 'n1' }, null, 'bad'], todos: {}, notebooks: [], folders: [] }));
assert.equal(normalized.ok, true);
assert.deepEqual(normalized.data.notes, [{ id: 'n1' }]);
assert.deepEqual(normalized.data.todos, []);
assert.ok(normalized.issues.includes('todos 必须是数组'));

assert.equal(core.recoveryKey(123), 'marginote.data.recovery.123');
assert.equal(core.CURRENT_SCHEMA_VERSION, 1);

const current = core.parsePersistedData(JSON.stringify({ schemaVersion: 1, notes: [], todos: [], notebooks: [], folders: [] }));
assert.equal(current.ok, true);
assert.equal(current.migrated, false);

const future = core.parsePersistedData(JSON.stringify({ schemaVersion: 2, notes: [] }));
assert.equal(future.ok, false);
assert.match(future.issues[0], /高于当前支持/);

const invalidVersion = core.parsePersistedData(JSON.stringify({ schemaVersion: 'next', notes: [] }));
assert.equal(invalidVersion.ok, false);
