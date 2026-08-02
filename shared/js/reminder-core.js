// Reminder scheduling rules shared by the UI and unit tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarginoteReminderCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function planTodoReminders(todo, nowMs) {
    if (!todo || todo.done) return [];
    const now = finiteNumber(nowMs, Date.now());
    const snoozedUntil = finiteNumber(todo.remindSnoozedUntil, 0);
    if (snoozedUntil > now) {
      return [{ key: 'snooze', when: snoozedUntil, snoozed: true }];
    }

    const dueDate = finiteNumber(todo.dueDate, 0);
    const count = Math.max(0, Math.floor(finiteNumber(todo.remindCount, 0)));
    if (!dueDate || count === 0) return [];

    const before = Math.max(0, finiteNumber(todo.remindBeforeMin, 0));
    const interval = Math.max(1, finiteNumber(todo.remindIntervalMin, 5));
    const reminders = [];
    for (let index = 0; index < count; index++) {
      const offsetMinutes = before - index * interval;
      const when = dueDate - offsetMinutes * 60_000;
      if (when > now) reminders.push({ key: String(index), when, snoozed: false });
    }
    return reminders;
  }

  return { planTodoReminders };
});
