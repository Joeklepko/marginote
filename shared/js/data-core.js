// Marginote 持久化数据的纯逻辑边界：只负责解析/结构校验，不访问 DOM 或存储。
// 浏览器与 Node 双导出，便于对数据恢复路径做离线回归测试。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MarginoteDataCore = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const CURRENT_SCHEMA_VERSION = 1;
  const COLLECTION_FIELDS = ['notebooks', 'folders', 'notes', 'todos'];

  function parsePersistedData(raw) {
    if (raw == null || raw === '') return { ok: true, data: null, issues: [] };
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { ok: false, data: null, issues: ['主数据不是有效 JSON'], error };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, data: null, issues: ['主数据顶层必须是对象'], error: new Error('主数据顶层必须是对象') };
    }

    const sourceSchemaVersion = value.schemaVersion == null ? 0 : Number(value.schemaVersion);
    if (!Number.isInteger(sourceSchemaVersion) || sourceSchemaVersion < 0) {
      return { ok: false, data: null, issues: ['schemaVersion 必须是非负整数'], error: new Error('schemaVersion 非法') };
    }
    if (sourceSchemaVersion > CURRENT_SCHEMA_VERSION) {
      return {
        ok: false,
        data: null,
        issues: [`数据版本 ${sourceSchemaVersion} 高于当前支持的 ${CURRENT_SCHEMA_VERSION}`],
        error: new Error('数据由更高版本 Marginote 创建')
      };
    }

    const issues = [];
    const data = { schemaVersion: CURRENT_SCHEMA_VERSION };
    for (const field of COLLECTION_FIELDS) {
      if (value[field] == null) data[field] = [];
      else if (Array.isArray(value[field])) data[field] = value[field].filter(item => item && typeof item === 'object' && !Array.isArray(item));
      else {
        data[field] = [];
        issues.push(`${field} 必须是数组`);
      }
    }
    if (value.images == null) data.images = {};
    else if (typeof value.images === 'object' && !Array.isArray(value.images)) data.images = value.images;
    else {
      data.images = {};
      issues.push('images 必须是对象');
    }
    return { ok: true, data, issues, sourceSchemaVersion, migrated: sourceSchemaVersion < CURRENT_SCHEMA_VERSION };
  }

  function recoveryKey(timestamp) {
    const value = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
    return `marginote.data.recovery.${value}`;
  }

  return { parsePersistedData, recoveryKey, COLLECTION_FIELDS, CURRENT_SCHEMA_VERSION };
});
