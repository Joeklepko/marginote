# Marginote 架构边界

状态：active
最后核验：2026-08-02（v1.2.4）

## 产品边界

Windows/Tauri 是主产品，浏览器扩展是兼容运行形态。二者共享数据模型、AI Prompt/Skill/Provider 纯逻辑和工具策略；平台存储、系统提醒、工作目录与 CLI 桥由各端适配。

```text
用户 / 内置 AI / marginote-cli
              │
       ToolPolicy + Skill
              │
     Assistant / CLI dispatcher
              │
       Repository transaction
              │
 桌面 Markdown 工作目录（主数据）
```

## 模块职责

| 层 | 主要文件 | 约束 |
|---|---|---|
| 数据契约 | `data-core.js` | 校验、迁移和损坏保护；不访问 DOM |
| 事务 | `repository-core.js` | 串行写入、快照、差异、回滚和 change-set |
| 工作目录 | `workdir-core.js` + Rust `workdir.rs` | 对账计划、受限路径和原子文件替换 |
| 工具策略 | `tool-policy-core.js` | 唯一声明读写等级、事务、CLI 暴露和兼容别名 |
| AI Skill | `assistant-skill-core.js` | 按意图组合最小工具集和步骤预算 |
| AI Runtime | `assistant-core.js` | 响应解析、上下文裁剪、结果收集和失败分类纯逻辑 |
| AI Prompt | `assistant-prompt-core.js` | system 规则与不可信本地上下文的唯一构建入口 |
| Provider | `ai-provider-core.js` | 请求、Header、SSE、工具调用、token 与重试 |
| 端侧编排 | `assistant.js`, `app.js` | DOM、模型调用、确认、收据与业务工具实现 |
| CLI | `cli-core.js`, Rust `desktop/cli` | 稳定命令、JSON 信封、退出码和本机令牌桥 |

依赖只能从端侧编排指向纯逻辑核心。核心模块不得依赖 DOM、WebView 存储或 Tauri API。

## 写入规则

1. AI/CLI 非破坏性写入必须经过 Repository；事务内只持有同步本地变更，不等待模型或网络。
2. 删除必须经过明确确认，并保留现有软删除/回收站语义。
3. 工作目录是数据投影时，文件写入必须使用原子替换；外部差异先形成 plan 再提交。
4. 模型声明“已保存”不算成功，只有工具收据可证明写入。
5. 新增工具必须同时登记策略、Skill 归属和测试；兼容别名不得继续暴露给新 Prompt。
6. Agent 写入必须携带可重试的 `requestId`；`--dry-run` 只生成计划，不能进入业务工具或持久化。
7. 批量文件导入以用户本次选择为事务边界；任一输入失败时恢复集合快照并清理本批新增图片。
8. 对话中的选中文本默认只读；原位写回必须走编辑器 AI 文本事务，不能用整篇更新工具替代选区 patch。
9. Windows 桌面主数据必须按实体写入工作目录：目录对应笔记本/文件夹，每篇笔记和每条待办对应独立文件。`_marginote/meta.json` 只能保存结构、索引和轻量元信息，不能聚合正文。迁移必须先成功写盘，再清理旧主数据键。

## 共享与生成

`shared/js/` 是以下纯逻辑文件的唯一源：

- `ai-provider-core.js`
- `ai-edit-core.js`
- `editor-ui-core.js`
- `assistant-core.js`
- `assistant-prompt-core.js`
- `assistant-skill-core.js`
- `tool-policy-core.js`

运行 `npm run sync:extension` 刷新扩展副本，`npm run check:copies` 会在 CI 阻止漂移。`app.js`、`index.html` 与端侧 `assistant.js` 暂时仍有平台差异，不应机械覆盖。

## 当前已知债务

- 普通 UI 写入口尚未全部迁入 Repository，工作目录仍是可选投影。
- `app.js`、`index.html` 和端侧 `assistant.js` 仍偏大，且保留少量历史函数覆盖；拆分应以纯逻辑与测试先行为原则小步进行。
- AI API Key 尚存本机 Web 存储，Windows 凭据管理迁移需要兼容旧配置与安装升级验证。
- UI/AI/CLI 尚未共用段落级搜索索引；大库性能与引用精度仍需专门迭代。
- ZIP 导入已有失败回滚与资源上限，但尚缺冲突预览、覆盖/副本策略和完整 IndexedDB round-trip E2E。
- 工作目录文件监听、冲突预览、Windows 签名与自动更新尚未完成。

## 开发门禁

```bash
npm run check
npm run test:js
npm run test:cli
npm run test:desktop
# 或一次运行
npm run verify
```

发布前还应运行 Rust format/clippy、Tauri release build，并在 Windows 实机完成安装、提醒、CLI 自动拉起与升级数据验证。
