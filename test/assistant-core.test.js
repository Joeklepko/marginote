const core = require('../shared/js/assistant-core.js');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log('✓', name); }
  else { failed++; console.error('✗ FAIL', name); }
}

const notebooks = [{ id: 'work', name: '产品工作' }, { id: 'life', name: '生活' }];
const notes = [
  { id: 'a', notebookId: 'work', title: '用药功能交付计划', content: '灰度测试完成后，计划在 7 月 15 日正式上线。', tags: ['路线图'], updatedAt: 30 },
  { id: 'b', notebookId: 'life', title: '七月购物清单', content: '购买药盒、牛奶和纸巾。', tags: [], updatedAt: 50 },
  { id: 'c', notebookId: 'work', title: '登录页改版', content: '预计 8 月上线新的登录页面。', tags: ['设计'], updatedAt: 40 }
];

check('中文自然问句能提取有效关键词', core.queryKeywords('帮我查一下笔记里用药什么时候上线？').includes('用药'));
check('中文模糊检索把用药计划排第一', core.rankNotes(notes, notebooks, '用药上线时间', 3)[0].note.id === 'a');
check('标题权重高于正文偶然命中', core.rankNotes(notes, notebooks, '登录页改版', 3)[0].note.id === 'c');
check('查笔记被识别为查询意图', core.classifyIntent('查一下用药上线时间').kind === 'note_query');
check('不带查找动词的直接提问也会主动预检索笔记', (() => {
  const intent = core.classifyIntent('项目复盘里最终决定了什么？');
  return intent.kind === 'note_query' && intent.prefetchNotes && intent.query.includes('项目复盘');
})());
check('询问提醒功能设计不会被“提醒”二字误路由成待办', (() => {
  const intent = core.classifyIntent('提醒功能最终采用了什么设计方案？');
  return intent.kind === 'note_query' && intent.prefetchNotes;
})());
check('询问记录内容不会被“记录”二字误判为创建', core.classifyIntent('之前的记录里有什么').kind === 'note_query');
check('明确要求记录内容仍识别为创建笔记', core.classifyIntent('帮我记录一下今天的想法').kind === 'note_write');
check('口语化“记下来”会开放创建笔记能力', (() => {
  const plan = core.planAssistantTurn('把下面这段内容记下来：接口今天联调完成', [], 64);
  return plan.intent.kind === 'note_write'
    && plan.intent.prefetchNotes
    && plan.intent.query.includes('接口今天联调完成')
    && !plan.intent.query.includes('记下来')
    && plan.allowedToolNames.includes('create_note')
    && plan.allowedToolNames.includes('append_to_note');
})());
check('“写个笔记”和“记一笔”都会开放创建笔记能力', (() => {
  const writeNote = core.planAssistantTurn('帮我写个笔记：今天完成了发布验证', [], 64);
  const jotDown = core.planAssistantTurn('记一笔：下周检查同步性能', [], 64);
  return writeNote.allowedToolNames.includes('create_note') && jotDown.allowedToolNames.includes('create_note');
})());
check('写进指定笔记会走编辑而不是误建新笔记', (() => {
  const plan = core.planAssistantTurn('把这段话写进项目复盘笔记', [], 64);
  return plan.intent.kind === 'note_write' && plan.allowedToolNames.includes('append_to_note') && !plan.allowedToolNames.includes('create_note');
})());
check('新建待办不触发笔记预检索', core.classifyIntent('新建待办：明天交周报').prefetchNotes === false);
check('64K 上下文仅保留最近 16 条消息', core.selectRecentHistory(Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) })), 64).length === 16);
check('查询意图不暴露删除工具', !core.selectToolNames(core.classifyIntent('查一下用药计划')).includes('delete_note'));
check('翻译笔记会暴露真实写入工具', core.selectToolNames(core.classifyIntent('把这篇笔记翻译成英文')).includes('translate_note'));
check('新建笔记只开放创建能力', (() => {
  const plan = core.planAssistantTurn('新建一篇会议笔记', [], 64);
  return plan.intent.capabilities.join(',') === 'capture'
    && plan.allowedToolNames.includes('create_note')
    && !plan.allowedToolNames.includes('update_note')
    && !plan.allowedToolNames.includes('delete_note');
})());
check('删除单篇笔记不开放批量删除或笔记本删除', (() => {
  const tools = core.planAssistantTurn('删除这篇笔记', [], 64).allowedToolNames;
  return tools.includes('delete_note') && !tools.includes('batch_delete_notes') && !tools.includes('delete_notebook');
})());
check('复杂条件批量删除不会因动作和对象距离较远而丢失删除权限', (() => {
  const plan = core.planAssistantTurn('帮我删除所有标题为空或者内容为空的笔记', [], 64);
  return plan.intent.capabilities.includes('delete')
    && plan.intent.capabilities.includes('batch')
    && plan.allowedToolNames.includes('query_notes')
    && plan.allowedToolNames.includes('delete_notes_by_query');
})());
check('批量移动笔记不会获得删除能力', (() => {
  const tools = core.planAssistantTurn('把这些笔记移动到工作笔记本', [], 64).allowedToolNames;
  return tools.includes('batch_move_notes') && !tools.includes('batch_delete_notes') && !tools.includes('delete_note');
})());
check('自然语言提醒被识别为创建待办', (() => {
  const plan = core.planAssistantTurn('明天九点提醒我交周报', [], 64);
  return plan.intent.kind === 'todo_write' && plan.allowedToolNames.includes('create_todo') && !plan.allowedToolNames.includes('delete_todo');
})());
check('批量完成待办只开放完成能力', (() => {
  const plan = core.planAssistantTurn('批量完成这些待办', [], 64);
  return plan.intent.kind === 'todo_write' && plan.allowedToolNames.includes('batch_complete_todos') && !plan.allowedToolNames.includes('batch_delete_todos');
})());
check('查看已完成待办仍是只读查询', core.classifyIntent('查看已完成待办').kind === 'todo_query');
check('待办附件会在共享规划器中修正写入领域', (() => {
  const plan = core.planAssistantTurn('把标题修改为交付周报', [{ type: 'todo', id: 't1' }], 64);
  return plan.intent.kind === 'todo_write' && plan.allowedToolNames.includes('update_todo') && !plan.allowedToolNames.includes('update_note');
})());
check('番茄钟在通用意图中可用', core.selectToolNames(core.classifyIntent('开始专注二十五分钟')).includes('pomodoro'));
check('笔记标题含待办二字仍识别为新建笔记', core.classifyIntent('新建笔记：待办事项设计方案').kind === 'note_write');
check('待办内容含笔记二字仍识别为新建待办', core.classifyIntent('新建待办：整理笔记').kind === 'todo_write');
check('普通记录请求不会开放持久记忆写入', !core.selectToolNames(core.classifyIntent('记录一篇今天的会议笔记')).includes('save_memory'));
check('明确要求记住时才开放记忆写入', core.selectToolNames(core.classifyIntent('请记住我偏好使用中文')).includes('save_memory'));
check('保存到记忆中的自然表达会开放记忆写入', core.selectToolNames(core.classifyIntent('把我的项目代号保存到记忆中')).includes('save_memory'));
check('明确约定以后称呼也会写入记忆而非笔记', (() => {
  const plan = core.planAssistantTurn('以后叫我小余', [], 64);
  return plan.intent.kind === 'memory' && plan.allowedToolNames.includes('save_memory') && !plan.allowedToolNames.includes('create_note');
})());
check('查询记忆不会开放记忆写入', !core.selectToolNames(core.classifyIntent('你记得我的偏好吗')).includes('save_memory'));
check('明确删除记忆时开放查询和删除', ['recall_memory', 'delete_memory'].every(name => core.selectToolNames(core.classifyIntent('删除你记住的语言偏好')).includes(name)));
check('纯记忆删除不会同时开放笔记删除', !core.selectToolNames(core.classifyIntent('删除你记住的语言偏好')).includes('delete_note'));
check('未列入本轮集合的工具在运行时判定为禁止', !core.isToolAllowed('sub_agent', new Set(['search_notes'])));
check('连续对话历史保留上一轮写入目标 ID', core.summarizeToolLogForHistory([
  { tool: 'create_note', ok: true, targetType: 'note', targetId: 'note-123' }
]) === 'create_note✓(note id:note-123)');
check('普通请求只带入偏好和相关记忆', (() => {
  const memories = [
    { category: 'preference', key: '语言', value: '中文' },
    { category: 'fact', key: '项目代号', value: '北极星' },
    { category: 'fact', key: '宠物', value: '小猫' }
  ];
  const selected = core.selectRelevantMemories(memories, '项目代号是什么', core.classifyIntent('项目代号是什么'), 10);
  return selected.length === 2 && selected.some(item => item.key === '语言') && selected.some(item => item.key === '项目代号') && !selected.some(item => item.key === '宠物');
})());
check('明确查询记忆时允许读取完整记忆列表', (() => {
  const memories = Array.from({ length: 12 }, (_, index) => ({ category: 'fact', key: `k${index}`, value: `v${index}` }));
  return core.selectRelevantMemories(memories, '查看我的记忆', core.classifyIntent('查看我的记忆'), 10).length === 10;
})());

check('通用结构化查询支持或者、并且与稳定分页', (() => {
  const sample = [
    { id: 'blank-title', notebookId: 'work', title: '   ', content: '正文', updatedAt: 50 },
    { id: 'blank-content', notebookId: 'work', title: '有标题', content: '\n ', updatedAt: 40 },
    { id: 'both-empty', notebookId: 'work', title: '', content: '', updatedAt: 30 },
    { id: 'normal', notebookId: 'work', title: '正常', content: '正文', updatedAt: 20 },
    { id: 'deleted-empty', notebookId: 'work', title: '', content: '', deleted: true, updatedAt: 60 }
  ];
  const where = [{ field: 'title', operator: 'empty' }, { field: 'content', operator: 'empty' }];
  const first = core.queryNotes(sample, notebooks, { where, combine: 'any', limit: 2 });
  const second = core.queryNotes(sample, notebooks, { where, combine: 'any', cursor: first.nextCursor, limit: 2 });
  const both = core.queryNotes(sample, notebooks, { where, combine: 'all' });
  return first.total === 3 && first.items.length === 2 && first.nextCursor === 2
    && second.items.length === 1 && second.nextCursor === null
    && both.total === 1 && both.items[0].id === 'both-empty';
})());

check('相关度搜索游标可以读取首屏以后的结果', (() => {
  const many = Array.from({ length: 230 }, (_, index) => ({ id: `page-${index}`, notebookId: 'work', title: `第${index}篇`, content: '', updatedAt: 1000 - index }));
  const first = core.rankNotes(many, notebooks, '', 30, 0);
  const afterTwoHundred = core.rankNotes(many, notebooks, '', 30, 200);
  return first.length === 30 && afterTwoHundred.length === 30
    && first[0].note.id === 'page-0' && afterTwoHundred[0].note.id === 'page-200';
})());

check('结构化查询总数不受普通搜索二百篇上限影响', (() => {
  const many = Array.from({ length: 250 }, (_, index) => ({ id: `empty-${index}`, notebookId: 'work', title: '', content: index % 2 ? '' : '正文', updatedAt: index }));
  const result = core.queryNotes(many, notebooks, { where: [{ field: 'title', operator: 'empty' }], limit: 100 });
  return result.total === 250 && result.items.length === 100 && result.hasMore && result.nextCursor === 100;
})());

check('结构化查询不是空值专用实现', (() => {
  const sample = [
    { id: 'roadmap', notebookId: 'work', title: 'Q3 路线图', content: '桌面版发布', tags: ['发布'], starred: true, updatedAt: 30 },
    { id: 'meeting', notebookId: 'work', title: '周会', content: '普通记录', tags: ['会议'], starred: false, updatedAt: 20 },
    { id: 'life-note', notebookId: 'life', title: '生活记录', content: '采购', tags: ['清单'], starred: false, updatedAt: 10 }
  ];
  const result = core.queryNotes(sample, notebooks, {
    where: [
      { field: 'notebook', operator: 'equals', value: '产品工作' },
      { field: 'title', operator: 'starts_with', value: 'Q3' },
      { field: 'tag', operator: 'equals', value: '发布' },
      { field: 'type', operator: 'equals', value: 'markdown' },
      { field: 'starred', operator: 'equals', value: true }
    ],
    combine: 'all'
  });
  return result.total === 1 && result.items[0].id === 'roadmap';
})());

(async () => {
  const resolved = await core.resolveNoteAttachmentImages(
    [{ type: 'note', id: 'a' }, { type: 'image', dataUrl: 'direct' }, { type: 'note', id: 'b' }],
    id => ({ id, content: id }),
    async content => [{ dataUrl: `image:${content}` }]
  );
  check('异步汇总全部笔记附件图片', resolved.map(item => item.dataUrl).join(',') === 'image:a,image:b');

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  failed++;
  console.error('✗ FAIL 异步附件图片测试', error);
  process.exit(1);
});
