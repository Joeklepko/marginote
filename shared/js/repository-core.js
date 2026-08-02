// Marginote 集合 Repository / UnitOfWork 纯逻辑。
// 负责串行执行、快照、change-set、一次持久化和失败恢复；具体存储/UI 由调用方注入。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MarginoteRepositoryCore = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const COLLECTIONS = ['notebooks', 'folders', 'notes', 'todos', 'memories'];
  let nextId = 0;

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function stable(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }

  function changedFields(before, after) {
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    return [...keys].filter(key => stable(before?.[key]) !== stable(after?.[key])).sort();
  }

  function indexById(items) {
    const index = new Map();
    for (const item of items || []) {
      const identity = item && (item.id != null ? item.id : item.key);
      if (identity != null) index.set(String(identity), item);
    }
    return index;
  }

  function diffStates(before, after) {
    const changes = [];
    for (const collection of COLLECTIONS) {
      const oldItems = indexById(before?.[collection]);
      const newItems = indexById(after?.[collection]);
      const ids = [...new Set([...oldItems.keys(), ...newItems.keys()])].sort();
      for (const id of ids) {
        const oldItem = oldItems.get(id);
        const newItem = newItems.get(id);
        if (!oldItem && newItem) {
          changes.push({ collection, id, type: 'created', fields: Object.keys(newItem).sort(), before: null, after: clone(newItem) });
        } else if (oldItem && !newItem) {
          changes.push({ collection, id, type: 'deleted', fields: Object.keys(oldItem).sort(), before: clone(oldItem), after: null });
        } else {
          const fields = changedFields(oldItem, newItem);
          if (fields.length) changes.push({ collection, id, type: 'updated', fields, before: clone(oldItem), after: clone(newItem) });
        }
      }
    }
    return changes;
  }

  function summarize(changes) {
    const counts = { created: 0, updated: 0, deleted: 0 };
    const collections = {};
    for (const change of changes || []) {
      counts[change.type] = (counts[change.type] || 0) + 1;
      collections[change.collection] = (collections[change.collection] || 0) + 1;
    }
    return { counts, collections, total: (changes || []).length };
  }

  function changeSet(label, before, after, status, error, startedAt) {
    const changes = diffStates(before, after);
    const committedAt = Date.now();
    nextId += 1;
    return {
      id: `cs-${committedAt.toString(36)}-${nextId.toString(36)}`,
      label: String(label || 'mutation'),
      status,
      startedAt,
      committedAt,
      error: error ? String(error.message || error) : null,
      changes,
      summary: summarize(changes)
    };
  }

  function createRepository(deps) {
    if (!deps || typeof deps.readState !== 'function' || typeof deps.replaceState !== 'function' || typeof deps.persist !== 'function') {
      throw new Error('Repository dependencies missing');
    }
    let queue = Promise.resolve();
    let last = null;

    async function execute(label, task, metadata) {
      const startedAt = Date.now();
      const before = clone(deps.readState());
      if (typeof deps.onBegin === 'function') await deps.onBegin({ label, metadata, startedAt });

      let value;
      let current;
      try {
        value = await task();
        current = clone(deps.readState());
      } catch (error) {
        current = clone(deps.readState());
        const rolledBack = changeSet(label, before, current, 'rolled_back', error, startedAt);
        deps.replaceState(clone(before));
        if (typeof deps.onRollback === 'function') {
          try { await deps.onRollback(rolledBack, error, { phase: 'execute', metadata }); } catch {}
        }
        if (typeof deps.onEnd === 'function') {
          try { await deps.onEnd({ committed: false, changeSet: rolledBack, metadata }); } catch {}
        }
        throw error;
      }

      const committed = changeSet(label, before, current, 'committed', null, startedAt);
      if (!committed.changes.length) {
        if (typeof deps.onEnd === 'function') await deps.onEnd({ committed: true, changeSet: null, metadata });
        return { value, changeSet: null };
      }

      try {
        await deps.persist(current, committed, metadata);
      } catch (error) {
        const rolledBack = { ...committed, status: 'rolled_back', error: String(error.message || error) };
        deps.replaceState(clone(before));
        if (typeof deps.onRollback === 'function') {
          try { await deps.onRollback(rolledBack, error, { phase: 'persist', metadata }); } catch {}
        }
        if (typeof deps.onEnd === 'function') {
          try { await deps.onEnd({ committed: false, changeSet: rolledBack, metadata }); } catch {}
        }
        throw error;
      }

      last = committed;
      if (typeof deps.onCommit === 'function') {
        // Audit persistence must not turn an already persisted business mutation
        // into a false failure.
        try { await deps.onCommit(committed, metadata); } catch {}
      }
      if (typeof deps.onEnd === 'function') await deps.onEnd({ committed: true, changeSet: committed, metadata });
      return { value, changeSet: committed };
    }

    function run(label, task, metadata) {
      if (typeof task !== 'function') return Promise.reject(new Error('transaction task missing'));
      const result = queue.then(() => execute(label, task, metadata), () => execute(label, task, metadata));
      queue = result.then(() => undefined, () => undefined);
      return result;
    }

    return {
      run,
      lastChangeSet: () => last && clone(last),
      diffStates,
      summarize
    };
  }

  return { COLLECTIONS, clone, diffStates, summarize, createRepository };
});
