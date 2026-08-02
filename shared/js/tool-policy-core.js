// Marginote 业务工具的唯一策略注册表。
// 这里只描述权限、事务和暴露面，不包含 DOM 或具体业务实现。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarginoteToolPolicyCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULTS = Object.freeze({
    assistant: true,
    cli: false,
    access: 'read',
    transaction: 'none',
    workdirProjection: false,
    deprecated: false,
    aliasOf: null,
    replacedBy: null
  });

  // cli: "direct" 表示 CLI 可直接调用同名 ASSISTANT_TOOLS；"virtual" 表示由 cli-core 组合或转换。
  const DEFINITIONS = {
    list_notebooks: { cli: 'direct' },
    search_notes: { cli: 'direct' },
    query_notes: {},
    search_todos: { cli: 'direct' },
    create_note: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    create_todo: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    update_note: { access: 'write', transaction: 'repository', workdirProjection: true },
    update_todo: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    create_notebook: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    rename_notebook: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    delete_notebook: { cli: 'direct', access: 'destructive', transaction: 'direct', workdirProjection: true },
    move_note: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    delete_note: { cli: 'direct', access: 'destructive', transaction: 'direct', workdirProjection: true },
    optimize_text: {},
    get_note: { cli: 'direct' },
    get_todo: { cli: 'direct' },
    save_memory: { access: 'write', transaction: 'direct', workdirProjection: true },
    recall_memory: {},
    delete_memory: { access: 'destructive', transaction: 'direct', workdirProjection: true },
    batch_move_notes: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    batch_update_notes: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    batch_complete_todos: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    batch_delete_notes: { cli: 'direct', access: 'destructive', transaction: 'direct', workdirProjection: true },
    delete_notes_by_query: { access: 'destructive', transaction: 'direct', workdirProjection: true },
    add_tags: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    remove_tags: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    list_tags: { cli: 'direct' },
    daily_briefing: {},
    note_stats: { cli: 'direct' },
    create_from_template: { access: 'write', transaction: 'repository', workdirProjection: true },
    summarize_note: {},
    create_folder: { access: 'write', transaction: 'repository', workdirProjection: true },
    move_note_to_folder: { access: 'write', transaction: 'repository', workdirProjection: true },
    list_todos: { cli: 'direct', deprecated: true, replacedBy: ['search_todos'] },
    complete_todo: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    delete_todo: { cli: 'direct', access: 'destructive', transaction: 'direct', workdirProjection: true },
    batch_delete_todos: { cli: 'direct', access: 'destructive', transaction: 'direct', workdirProjection: true },
    find_note: { deprecated: true, replacedBy: ['search_notes', 'get_note'] },
    quick_note: { access: 'write', transaction: 'repository', workdirProjection: true, deprecated: true, aliasOf: 'create_note' },
    quick_todo: { access: 'write', transaction: 'repository', workdirProjection: true, deprecated: true, aliasOf: 'create_todo' },
    auto_title_notes: { access: 'write', transaction: 'repository', workdirProjection: true },
    list_recent_notes: {},
    count_notes: {},
    research: {},
    translate: {},
    extract_keywords: {},
    translate_note: { access: 'write', transaction: 'direct', workdirProjection: true },
    append_to_note: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    duplicate_note: { access: 'write', transaction: 'repository', workdirProjection: true },
    merge_notes: { access: 'write', transaction: 'repository', workdirProjection: true },
    star_note: { cli: 'direct', access: 'write', transaction: 'repository', workdirProjection: true },
    list_starred: {},
    word_count: { cli: 'direct' },
    clean_text: { access: 'write', transaction: 'direct', workdirProjection: true },
    export_note: { cli: 'direct' },
    pomodoro: { access: 'write', transaction: 'direct', workdirProjection: false },

    status: { assistant: false, cli: 'virtual' },
    search_all: { assistant: false, cli: 'virtual' },
    list_notes: { assistant: false, cli: 'virtual' },
    update_note_cli: { assistant: false, cli: 'virtual', access: 'write', transaction: 'repository', workdirProjection: true },
    rename_notebook_cli: { assistant: false, cli: 'virtual', access: 'write', transaction: 'repository', workdirProjection: true },
    delete_notebook_cli: { assistant: false, cli: 'virtual', access: 'destructive', transaction: 'direct', workdirProjection: true }
  };

  const POLICIES = Object.freeze(Object.fromEntries(Object.entries(DEFINITIONS).map(([name, definition]) => {
    const policy = Object.freeze({ name, ...DEFAULTS, ...definition });
    if (!['read', 'write', 'destructive'].includes(policy.access)) throw new Error(`工具 ${name} 的 access 无效`);
    if (!['none', 'repository', 'direct'].includes(policy.transaction)) throw new Error(`工具 ${name} 的 transaction 无效`);
    if (![false, 'direct', 'virtual'].includes(policy.cli)) throw new Error(`工具 ${name} 的 cli 暴露方式无效`);
    if (policy.access === 'read' && policy.transaction !== 'none') throw new Error(`只读工具 ${name} 不应声明事务`);
    if (policy.aliasOf && !DEFINITIONS[policy.aliasOf]) throw new Error(`工具 ${name} 的 aliasOf 不存在：${policy.aliasOf}`);
    return [name, policy];
  })));

  function getPolicy(name) {
    return POLICIES[String(name || '')] || null;
  }

  function namesWhere(predicate) {
    return Object.values(POLICIES).filter(predicate).map(policy => policy.name);
  }

  function assistantToolNames() {
    return namesWhere(policy => policy.assistant);
  }

  function assistantPromptToolNames() {
    return namesWhere(policy => policy.assistant && !policy.deprecated);
  }

  function cliCallNames() {
    return namesWhere(policy => !!policy.cli);
  }

  function cliDirectToolNames() {
    return namesWhere(policy => policy.cli === 'direct');
  }

  function isWrite(name) {
    const policy = getPolicy(name);
    return !!policy && policy.access !== 'read';
  }

  function isDestructive(name) {
    return getPolicy(name)?.access === 'destructive';
  }

  function usesRepositoryTransaction(name) {
    return getPolicy(name)?.transaction === 'repository';
  }

  function projectsToWorkdir(name) {
    return !!getPolicy(name)?.workdirProjection;
  }

  function assertAssistantTools(tools) {
    const actual = Object.keys(tools || {}).sort();
    const expected = assistantToolNames().sort();
    const missingPolicies = actual.filter(name => !expected.includes(name));
    const missingTools = expected.filter(name => !actual.includes(name));
    if (missingPolicies.length || missingTools.length) {
      throw new Error(`工具策略与实现不一致；未登记: ${missingPolicies.join(',') || '无'}；未实现: ${missingTools.join(',') || '无'}`);
    }
    return true;
  }

  return {
    POLICIES,
    getPolicy,
    assistantToolNames,
    assistantPromptToolNames,
    cliCallNames,
    cliDirectToolNames,
    isWrite,
    isDestructive,
    usesRepositoryTransaction,
    projectsToWorkdir,
    assertAssistantTools
  };
});
