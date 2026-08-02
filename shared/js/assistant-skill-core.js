// Marginote 内置 AI Skill/Profile 注册表。
// Profile 只组合原子工具并声明运行约束，不包含模型调用或数据写入实现。
(function (root, factory) {
  const policy = (root && root.MarginoteToolPolicyCore)
    || (typeof module === 'object' && module.exports ? require('./tool-policy-core.js') : null);
  const api = factory(policy);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarginoteAssistantSkillCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ToolPolicy) {
  if (!ToolPolicy) throw new Error('MarginoteToolPolicyCore 未加载');

  const VERSION = 2;

  const GROUPS = Object.freeze({
    note_query: Object.freeze([
      'search_notes', 'get_note', 'research', 'list_recent_notes',
      'list_starred', 'query_notes', 'count_notes', 'note_stats', 'word_count', 'list_tags',
      'export_note', 'extract_keywords', 'summarize_note'
    ]),
    text_transform: Object.freeze(['optimize_text', 'translate']),
    todo_query: Object.freeze(['search_todos', 'get_todo']),
    efficiency: Object.freeze(['daily_briefing', 'pomodoro'])
  });

  const CAPABILITIES = Object.freeze({
    note_write: Object.freeze({
      capture: Object.freeze({
        tools: Object.freeze(['create_note', 'create_from_template', 'append_to_note', 'update_note']),
        promptRule: '“记录”和“新建”都按内容语义归档，不按字面动词决定写入目标。先检查本地预检索、当前上下文和上一轮写入目标：只有同一具体主题或项目且新信息自然属于原笔记时才复用。新增事实用 append_to_note；纠错、替换或重组时先 get_note 读取全文，再 update_note 并保留无关内容。没有高置信匹配时才 create_note，常见词重合不等于相关。'
      }),
      edit: Object.freeze({
        tools: Object.freeze([
          'update_note', 'append_to_note', 'optimize_text', 'translate',
          'translate_note', 'clean_text', 'auto_title_notes'
        ]),
        promptRule: '编辑前先确认目标笔记；保留未要求改动的内容。'
      }),
      organize: Object.freeze({
        tools: Object.freeze([
          'move_note', 'move_note_to_folder', 'add_tags',
          'remove_tags', 'list_tags', 'star_note', 'duplicate_note', 'merge_notes',
          'create_folder', 'create_notebook', 'rename_notebook'
        ]),
        promptRule: '整理操作只影响用户指定的笔记、标签、文件夹或笔记本。'
      }),
      delete: Object.freeze({
        tools: Object.freeze(['delete_note']),
        promptRule: '删除前必须确认目标，且等待用户通过危险操作确认。'
      }),
      batch: Object.freeze({
        tools: Object.freeze([]),
        promptRule: '批量操作优先使用单次批量工具，并报告成功与失败数量。'
      })
    }),
    todo_write: Object.freeze({
      capture: Object.freeze({
        tools: Object.freeze(['create_todo']),
        promptRule: '创建待办时保留用户原意，并把明确日期转换为 ISO8601。'
      }),
      edit: Object.freeze({
        tools: Object.freeze(['update_todo']),
        promptRule: '更新前先确认待办 ID 和需要变化的字段。'
      }),
      complete: Object.freeze({
        tools: Object.freeze(['complete_todo']),
        promptRule: '只完成用户明确指定的待办。'
      }),
      delete: Object.freeze({
        tools: Object.freeze(['delete_todo']),
        promptRule: '删除前必须确认目标，且等待用户通过危险操作确认。'
      }),
      batch: Object.freeze({
        tools: Object.freeze([]),
        promptRule: '批量操作优先使用单次批量工具，并报告成功与失败数量。'
      })
    })
  });

  const CONDITIONAL_CAPABILITIES = Object.freeze({
    note_write: Object.freeze([
      Object.freeze({ requires: Object.freeze(['edit', 'batch']), tools: Object.freeze(['batch_update_notes', 'auto_title_notes']) }),
      Object.freeze({ requires: Object.freeze(['organize', 'batch']), tools: Object.freeze(['batch_move_notes']) }),
      Object.freeze({ requires: Object.freeze(['delete', 'batch']), tools: Object.freeze(['batch_delete_notes', 'delete_notes_by_query']) }),
      Object.freeze({ requires: Object.freeze(['organize', 'delete']), tools: Object.freeze(['delete_notebook']) })
    ]),
    todo_write: Object.freeze([
      Object.freeze({ requires: Object.freeze(['complete', 'batch']), tools: Object.freeze(['batch_complete_todos']) }),
      Object.freeze({ requires: Object.freeze(['delete', 'batch']), tools: Object.freeze(['batch_delete_todos']) })
    ])
  });

  function uniqueTools(...groups) {
    return [...new Set(groups.flat())];
  }

  function capabilityTools(kind) {
    return uniqueTools(
      Object.values(CAPABILITIES[kind] || {}).flatMap(capability => capability.tools),
      (CONDITIONAL_CAPABILITIES[kind] || []).flatMap(capability => capability.tools)
    );
  }

  const PROFILE_DEFINITIONS = {
    note_query: {
      label: '笔记检索',
      mutationPolicy: 'read-only',
      maxSteps: 6,
      tools: uniqueTools(GROUPS.note_query, GROUPS.todo_query.slice(0, 1), ['list_notebooks']),
      promptRules: ['用户直接询问事实时也必须主动使用本地预检索，不要求用户显式说“查找”；只有摘要不足时才读取全文。', '回答事实时注明来源笔记标题。']
    },
    note_write: {
      label: '笔记整理',
      mutationPolicy: 'confirmed-write',
      maxSteps: 10,
      tools: uniqueTools(GROUPS.note_query, capabilityTools('note_write')),
      promptRules: ['修改前先通过附件、检索结果或 ID 确认目标。', '能用一次批量工具完成时不要逐条重复调用。']
    },
    todo_query: {
      label: '待办查询',
      mutationPolicy: 'read-only',
      maxSteps: 5,
      tools: uniqueTools(GROUPS.todo_query, ['search_notes', 'get_note', 'list_notebooks']),
      promptRules: ['只查询和汇总待办，不创建、完成或删除事项。']
    },
    todo_write: {
      label: '待办管理',
      mutationPolicy: 'confirmed-write',
      maxSteps: 8,
      tools: uniqueTools(GROUPS.todo_query, capabilityTools('todo_write'), ['search_notes', 'get_note', 'list_notebooks']),
      promptRules: ['涉及日期时使用明确的 ISO8601 时间。', '修改或删除前先确认待办 ID。']
    },
    memory: {
      label: '持久记忆',
      mutationPolicy: 'explicit-memory-only',
      maxSteps: 3,
      tools: [],
      promptRules: ['只处理用户本轮明确提出的记住、查询记忆或删除记忆请求。']
    },
    general: {
      label: '通用助手',
      mutationPolicy: 'limited-write',
      maxSteps: 8,
      tools: uniqueTools(
        GROUPS.note_query.slice(0, 5),
        GROUPS.todo_query,
        ['create_note', 'update_note', 'append_to_note'],
        ['create_todo', 'update_todo', 'complete_todo'],
        ['list_notebooks', 'daily_briefing', 'note_stats', 'pomodoro'],
        GROUPS.text_transform
      ),
      promptRules: ['需求不明确时优先查询，不要猜测后直接修改数据。']
    }
  };

  const PROFILES = Object.freeze(Object.fromEntries(Object.entries(PROFILE_DEFINITIONS).map(([id, definition]) => {
    const tools = Object.freeze([...definition.tools]);
    for (const name of tools) {
      const policy = ToolPolicy.getPolicy(name);
      if (!policy || !policy.assistant) throw new Error(`Skill ${id} 引用了未知或非助手工具：${name}`);
      if (definition.mutationPolicy === 'read-only' && ToolPolicy.isWrite(name)) {
        throw new Error(`只读 Skill ${id} 不得包含写工具：${name}`);
      }
    }
    if (new Set(tools).size !== tools.length) throw new Error(`Skill ${id} 包含重复工具`);
    return [id, Object.freeze({ id, version: VERSION, ...definition, tools, promptRules: Object.freeze([...definition.promptRules]) })];
  })));

  function profileForIntent(intent) {
    return PROFILES[intent?.kind] || PROFILES.general;
  }

  function memoryTools(memoryAction) {
    if (memoryAction === 'save') return ['save_memory'];
    if (memoryAction === 'read') return ['recall_memory'];
    if (memoryAction === 'delete') return ['recall_memory', 'delete_memory'];
    return [];
  }

  function selectedCapabilities(intent) {
    const definitions = CAPABILITIES[intent?.kind];
    if (!definitions) return [];
    const requested = Array.isArray(intent?.capabilities) ? intent.capabilities : [];
    const selected = requested.filter(name => Object.hasOwn(definitions, name));
    // 内部旧调用若没有细分动作，降级到最小的编辑能力，不再回退到整个写入工具集。
    return [...new Set(selected.length ? selected : ['edit'])];
  }

  function selectionForIntent(intent) {
    const profile = profileForIntent(intent);
    const capabilities = selectedCapabilities(intent);
    const capabilityDefinitions = CAPABILITIES[profile.id] || {};
    const conditionalTools = (CONDITIONAL_CAPABILITIES[profile.id] || [])
      .filter(entry => entry.requires.every(name => capabilities.includes(name)))
      .flatMap(entry => entry.tools);
    const scopedTools = capabilities.length
      ? uniqueTools(
          profile.id === 'note_write'
            ? ['search_notes', 'query_notes', 'get_note', 'list_recent_notes', 'list_notebooks']
            : ['search_todos', 'get_todo', 'search_notes', 'get_note', 'list_notebooks'],
          capabilities.flatMap(name => capabilityDefinitions[name].tools),
          conditionalTools
        )
      : profile.tools;
    const tools = Object.freeze(uniqueTools(scopedTools, memoryTools(intent?.memoryAction)));
    const promptRules = Object.freeze(uniqueTools(
      profile.promptRules,
      capabilities.map(name => capabilityDefinitions[name].promptRule)
    ));
    return Object.freeze({
      id: profile.id,
      label: profile.label,
      version: profile.version,
      mutationPolicy: profile.mutationPolicy,
      maxSteps: profile.maxSteps,
      capabilities: Object.freeze(capabilities),
      tools,
      promptRules
    });
  }

  function selectToolNames(intent) {
    return [...selectionForIntent(intent).tools];
  }

  function maxSteps(intent, contextK) {
    const profile = profileForIntent(intent);
    if (profile.id === 'memory') return profile.maxSteps;
    return Math.min(12, profile.maxSteps + (Number(contextK) > 64 ? 2 : 0));
  }

  function unreachableToolNames() {
    const reachable = new Set([
      ...Object.values(PROFILES).flatMap(profile => profile.tools),
      ...memoryTools('save'), ...memoryTools('read'), ...memoryTools('delete')
    ]);
    return ToolPolicy.assistantToolNames().filter(name => !ToolPolicy.getPolicy(name)?.deprecated && !reachable.has(name));
  }

  const unreachable = unreachableToolNames();
  if (unreachable.length) throw new Error(`存在未归属任何 Skill 的助手工具：${unreachable.join(',')}`);

  return {
    VERSION,
    GROUPS,
    CAPABILITIES,
    CONDITIONAL_CAPABILITIES,
    PROFILES,
    profileForIntent,
    selectionForIntent,
    selectToolNames,
    maxSteps,
    unreachableToolNames
  };
});
