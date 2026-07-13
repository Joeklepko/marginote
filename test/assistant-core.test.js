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
check('新建待办不触发笔记预检索', core.classifyIntent('新建待办：明天交周报').prefetchNotes === false);
check('64K 上下文仅保留最近 16 条消息', core.selectRecentHistory(Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) })), 64).length === 16);
check('查询意图不暴露删除工具', !core.selectToolNames(core.classifyIntent('查一下用药计划')).includes('delete_note'));
check('翻译笔记会暴露真实写入工具', core.selectToolNames(core.classifyIntent('把这篇笔记翻译成英文')).includes('translate_note'));
check('番茄钟在通用意图中可用', core.selectToolNames(core.classifyIntent('开始专注二十五分钟')).includes('pomodoro'));
check('笔记标题含待办二字仍识别为新建笔记', core.classifyIntent('新建笔记：待办事项设计方案').kind === 'note_write');
check('待办内容含笔记二字仍识别为新建待办', core.classifyIntent('新建待办：整理笔记').kind === 'todo_write');

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
