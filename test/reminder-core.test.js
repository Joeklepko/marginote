const core = require('../shared/js/reminder-core.js');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log('✓', name); }
  else { failed++; console.error('✗ FAIL', name); }
}

const now = Date.UTC(2026, 7, 2, 8, 0, 0);

const onTime = core.planTodoReminders({
  dueDate: now + 60_000,
  remindBeforeMin: 0,
  remindCount: 1,
  remindIntervalMin: 5,
  done: false
}, now);
check('准时提醒不会被 0 分钟提前量误判为关闭', onTime.length === 1 && onTime[0].when === now + 60_000);

const disabled = core.planTodoReminders({
  dueDate: now + 60_000,
  remindBeforeMin: 0,
  remindCount: 0,
  done: false
}, now);
check('提醒次数为 0 时保持关闭', disabled.length === 0);

const repeated = core.planTodoReminders({
  dueDate: now + 60 * 60_000,
  remindBeforeMin: 30,
  remindCount: 3,
  remindIntervalMin: 5,
  done: false
}, now);
check('重复提醒按间隔生成', repeated.map(item => item.when).join(',') === [30, 35, 40].map(min => now + min * 60_000).join(','));

const snoozed = core.planTodoReminders({
  dueDate: now + 60_000,
  remindBeforeMin: 0,
  remindCount: 1,
  remindSnoozedUntil: now + 60 * 60_000,
  done: false
}, now);
check('稍后提醒覆盖原有提醒计划', snoozed.length === 1 && snoozed[0].key === 'snooze' && snoozed[0].when === now + 60 * 60_000);

check('已完成待办不再提醒', core.planTodoReminders({ dueDate: now + 60_000, remindCount: 1, done: true }, now).length === 0);

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
