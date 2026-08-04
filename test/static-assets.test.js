const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const htmlPath of ['shared/index.html', 'extension/index.html']) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.doesNotMatch(html, /fonts\.(?:googleapis|gstatic)\.com/, `${htmlPath} 启动时不得请求第三方网络字体`);
  assert.match(html, /<script\s+defer\s+src=["']vendor\/jszip\.min\.js["']><\/script>/, `${htmlPath} 不应让仅导入导出使用的 JSZip 阻塞首屏`);
  const base = path.dirname(htmlPath);
  const sources = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1]);
  assert.ok(sources.length > 0, `${htmlPath} 应加载本地脚本`);
  for (const source of sources) {
    if (/^(?:https?:)?\/\//i.test(source)) continue;
    assert.ok(fs.existsSync(path.resolve(base, source)), `${htmlPath} 引用的脚本不存在：${source}`);
  }
}

assert.doesNotMatch(
  fs.readFileSync('extension/manifest.json', 'utf8'),
  /fonts\.(?:googleapis|gstatic)\.com/,
  '扩展 CSP 不应继续放行已移除的第三方字体源'
);
assert.doesNotMatch(
  fs.readFileSync('desktop/src-tauri/tauri.conf.json', 'utf8'),
  /fonts\.(?:googleapis|gstatic)\.com/,
  '桌面 CSP 不应继续放行已移除的第三方字体源'
);

const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
assert.ok(fs.existsSync(path.resolve('extension', manifest.background.service_worker)), '扩展 service worker 必须存在');
for (const file of ['ai-edit-core.js', 'ai-provider-core.js', 'editor-ui-core.js', 'tool-policy-core.js', 'assistant-skill-core.js', 'assistant-core.js', 'assistant-prompt-core.js']) {
  assert.equal(
    fs.readFileSync(`shared/js/${file}`, 'utf8'),
    fs.readFileSync(`extension/js/${file}`, 'utf8'),
    `扩展的 ${file} 生成副本必须与 shared 源一致`
  );
}
for (const htmlPath of ['shared/index.html', 'extension/index.html']) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.ok(
    html.indexOf('js/ai-provider-core.js') < html.indexOf('app.js'),
    `${htmlPath} 必须在主应用前加载统一 Provider 运行时`
  );
  assert.ok(
    html.indexOf('js/ai-edit-core.js') < html.indexOf('app.js'),
    `${htmlPath} 必须在主应用前加载事务式 AI 编辑核心`
  );
  assert.ok(
    html.indexOf('js/tool-policy-core.js') < html.indexOf('js/assistant-skill-core.js')
      && html.indexOf('js/assistant-skill-core.js') < html.indexOf('js/assistant-core.js')
      && html.indexOf('js/assistant-core.js') < html.indexOf('js/assistant-prompt-core.js')
      && html.indexOf('js/assistant-prompt-core.js') < html.indexOf('js/assistant.js'),
    `${htmlPath} 必须按策略 → Skill → 助手核心 → Prompt → 助手实现的顺序加载`
  );
  for (const controlId of ['editorZoomOut', 'editorZoomValue', 'editorZoomIn', 'readingZoomOut', 'readingZoomValue', 'readingZoomIn']) {
    assert.match(html, new RegExp(`id=["']${controlId}["']`), `${htmlPath} 缺少可操作的缩放控件 ${controlId}`);
  }
  assert.match(html, /id=["']attachmentPickerSearch["']/, `${htmlPath} AI 附件选择器必须支持搜索`);
  assert.doesNotMatch(html, /id=["']assistantCurrentBtn["']/, `${htmlPath} 不应保留已由自动上下文替代的重复按钮`);
  assert.match(html, /\.app\.reading-mode \.editor-content\s*\{[^}]*width:\s*88vw/s, `${htmlPath} 阅读模式必须使用宽视口布局`);
}

const desktopHtml = fs.readFileSync('shared/index.html', 'utf8');
for (const controlId of ['windowMinimizeBtn', 'windowMaximizeBtn', 'windowCloseBtn']) {
  assert.match(desktopHtml, new RegExp(`id=["']${controlId}["']`), `桌面版缺少自绘窗口控制 ${controlId}`);
}
assert.doesNotMatch(desktopHtml, /id=["']cliStatusBar["']/, '桌面版不应继续占用底部空间展示 CLI 状态栏');
assert.match(desktopHtml, /data-tab=["']agent["']/, '桌面设置必须提供 Agent 集成入口');
for (const controlId of ['agentCodeAgentDir', 'agentPickCodeAgentDirBtn', 'agentInstallCodeAgentBtn', 'agentCopyCodeAgentBtn', 'agentRemoveCodeAgentBtn', 'agentCopyGenericBtn', 'agentDoctorBtn']) {
  assert.match(desktopHtml, new RegExp(`id=["']${controlId}["']`), `Agent 集成页缺少 ${controlId}`);
}
for (const removedControlId of ['agentInstallCodexBtn', 'agentCopyCodexBtn', 'agentRemoveCodexBtn', 'agentInstallClaudeBtn', 'agentCopyClaudeBtn', 'agentRemoveClaudeBtn']) {
  assert.doesNotMatch(desktopHtml, new RegExp(`id=["']${removedControlId}["']`), `Agent 集成页不应继续展示 ${removedControlId}`);
}

const desktopApp = fs.readFileSync('shared/app.js', 'utf8');
assert.match(desktopApp, /await loadDesktopWorkdirData\(\)/, '桌面启动必须先读取 Markdown 工作目录');
assert.match(desktopApp, /localStorage\.removeItem\(STORAGE_KEY\)/, '文件迁移成功后应清理受配额限制的旧主数据');
const desktopLoadStart = desktopApp.indexOf('async function loadDesktopWorkdirData()');
const desktopLoadEnd = desktopApp.indexOf('\nfunction saveData()', desktopLoadStart);
const desktopLoadSource = desktopApp.slice(desktopLoadStart, desktopLoadEnd);
assert.ok(
  desktopLoadSource.indexOf('loadData({ raw, legacyRaw') < desktopLoadSource.indexOf('initImagesIdb({ persistMigration: false, hydrateMetadata: false })'),
  '桌面升级必须先恢复旧主数据，再水合 IDB 图片元数据'
);
assert.match(
  desktopLoadSource,
  /if \(needsMigrationCommit \|\| needsIndexWrite\) \{[\s\S]*?adoptExistingFiles: hasDiskLibrary/,
  '启动接管已有文件库时只能补缺和更新索引，不能重写现有文件'
);
assert.ok(
  desktopLoadSource.indexOf('await workdirWriteAllNow') < desktopLoadSource.indexOf('await verifyWorkdirMigration(fs)')
    && desktopLoadSource.indexOf('await verifyWorkdirMigration(fs)') < desktopLoadSource.indexOf('localStorage.removeItem(STORAGE_KEY)'),
  '只有笔记、待办和图片通过落盘校验后才能清理旧数据'
);
assert.ok(
  desktopLoadSource.indexOf('notebooks = [];') < desktopLoadSource.indexOf('await workdirImportAllNow')
    && desktopLoadSource.indexOf('await workdirImportAllNow') < desktopLoadSource.indexOf('mergeLegacyEntitiesMissingFromDisk'),
  '已有独立文件库必须先以磁盘为准读取，再仅合并旧快照缺项'
);
const workdirWriteStart = desktopApp.indexOf('async function workdirWriteAllNow');
const workdirWriteEnd = desktopApp.indexOf('// 从工作目录读入并合并', workdirWriteStart);
const workdirWriteSource = desktopApp.slice(workdirWriteStart, workdirWriteEnd);
assert.match(
  workdirWriteSource,
  /const adopted = !!\(options\.adoptExistingFiles[\s\S]*?if \(unchanged \|\| adopted\)/,
  '接管模式必须跳过已经存在的笔记与待办文件'
);
assert.doesNotMatch(
  desktopApp.slice(desktopApp.indexOf('async function initImagesIdb'), desktopApp.indexOf('// 新增图片统一入口')),
  /if \(_idb\) return/,
  '图片仓已打开时仍需要可重入地恢复元数据'
);
assert.ok(
  desktopApp.indexOf('await restoreDesktopPreferences();') < desktopApp.indexOf('await loadDesktopWorkdirData()')
    && desktopApp.indexOf('bindEssentialSettingsEvents();') < desktopApp.indexOf('await loadDesktopWorkdirData()'),
  '原生配置、主题和设置入口必须在扫描笔记库之前恢复'
);
assert.match(desktopApp, /DESKTOP_PREFERENCES_STORAGE_KEY = 'desktopPreferencesV1'/, '桌面设置必须镜像到原生持久化存储');
assert.match(desktopApp, /await persistMainDataDurably\(state\)/, 'AI\/CLI 事务必须等待独立文件真正落盘');
assert.match(desktopApp, /deletedNoteFiles: deletedNoteIdToPath/, '回收站笔记正文也必须保存为独立文件');
assert.match(desktopApp, /`remindBeforeMin: \$\{/, '待办独立文件必须包含提醒提前量');
assert.match(desktopApp, /`remindIntervalMin: \$\{/, '待办独立文件必须包含重复提醒间隔');
assert.doesNotMatch(desktopApp, /platform\.mainData|loadDesktopMainData/, '桌面版不得退回聚合主数据 JSON');
const desktopCommands = fs.readFileSync('desktop/src-tauri/src/lib.rs', 'utf8');
assert.match(desktopCommands, /agent_integration::cmd_agent_integration/, '桌面端必须注册受限 Agent 集成命令');
assert.match(desktopCommands, /agent_integration::cmd_agent_pick_config_dir/, '桌面端必须注册 CodeAgent 配置目录选择器');
assert.match(desktopCommands, /workdir::cmd_workdir_ensure/, '桌面端必须能自动创建默认 Markdown 工作目录');
assert.match(desktopCommands, /workdir::cmd_workdir_read_texts/, '大笔记库启动应在 Rust 侧批量读取文本，避免逐文件 IPC');
assert.doesNotMatch(desktopCommands, /cmd_main_data_(?:get|set)/, '桌面端不得注册聚合主数据 JSON 命令');
const atomicFileSource = fs.readFileSync('desktop/src-tauri/src/atomic_file.rs', 'utf8');
assert.match(atomicFileSource, /replace_error\.kind\(\) == io::ErrorKind::PermissionDenied/, 'Windows 原子替换拒绝时应兼容允许原位写入的占用文件');

const cliDocs = fs.readFileSync('docs/cli.md', 'utf8');
assert.doesNotMatch(cliDocs, /CLI 状态栏/, 'CLI 文档不应继续宣称已移除的底部状态栏');
assert.match(cliDocs, /writable:false/, 'CLI 文档必须说明工作目录保护性只读状态');
assert.match(cliDocs, /CLI 默认授权查找、读取/, 'CLI 文档必须明确普通读写无需逐次授权');
assert.match(cliDocs, /不限制在 Marginote 工作目录内/, 'CLI 文档必须明确源文件不受工作目录限制');
assert.match(cliDocs, /note update <NOTE_ID> --content-file/, 'CLI 文档必须覆盖从文件更新笔记');
assert.match(cliDocs, /todo get <TODO_ID>/, 'CLI 文档必须覆盖待办详情读取');
assert.match(cliDocs, /notebook delete .* --yes/, 'CLI 文档必须覆盖笔记本删除确认');
assert.match(cliDocs, /--remind-count <次数>/, 'CLI 文档必须解释重复提醒次数');
assert.match(cliDocs, /batch_delete_todos/, 'CLI 文档必须覆盖 schema 暴露的高级批处理删除能力');
assert.match(cliDocs, /marginote-cli mcp/, 'CLI 文档必须说明内置 MCP Server');
assert.match(cliDocs, /mcp --profile full/, 'CLI 文档必须说明完整 MCP profile');
assert.match(cliDocs, /12 个工具/, 'CLI 文档必须说明默认精简工具集');
assert.match(cliDocs, /integrate install codeagent/, 'CLI 文档必须说明 CodeAgent 一键集成');
assert.doesNotMatch(cliDocs, /^codeagent mcp add/m, 'CodeAgent 不应再按不存在的 mcp add 命令接入');
assert.match(cliDocs, /marginote@local/, 'CLI 文档必须说明 CodeAgent 本地插件标识');
assert.match(cliDocs, /installed_plugins\.json/, 'CLI 文档必须说明 CodeAgent 插件注册表');
assert.match(cliDocs, /\.marginote\.bak/, 'CLI 文档必须说明 CodeAgent 配置备份');
assert.match(cliDocs, /--codeagent-dir/, 'CLI 文档必须说明非默认 CodeAgent 配置目录');
assert.match(cliDocs, /MARGINOTE_CODEAGENT_DIR/, 'CLI 文档必须说明 CodeAgent 配置目录环境变量');
assert.match(cliDocs, /设置 → Agent/, 'CLI 文档必须说明桌面 Agent 集成页');

const desktopPlatform = fs.readFileSync('shared/js/platform-desktop.js', 'utf8');
assert.match(desktopPlatform, /cmd_agent_integration/, '桌面平台层必须通过受限原生命令管理 Agent 集成');
assert.match(desktopPlatform, /cmd_agent_pick_config_dir/, '桌面平台层必须提供 CodeAgent 配置目录选择器');
const cliMain = fs.readFileSync('desktop/cli/src/main.rs', 'utf8');
assert.match(cliMain, /mod mcp;/, 'CLI 必须包含本地 MCP 协议模块');
assert.match(cliMain, /TopCommand::Mcp/, 'CLI 必须公开 mcp 子命令');
assert.match(cliMain, /default_value_t = McpProfile::Core/, 'MCP 必须默认使用核心工具集');
const mcpSource = fs.readFileSync('desktop/cli/src/mcp.rs', 'utf8');
assert.match(mcpSource, /"batch_manage"/, '核心 MCP 必须合并批处理入口');
assert.match(mcpSource, /assert_eq!\(full_tools\.len\(\), 23\)/, '完整 MCP 必须保留原有 23 个工具');
assert.match(cliMain, /IntegrateCommand::Install/, 'CLI 必须公开 Agent 一键安装命令');
assert.match(cliMain, /IntegrateCommand::Remove/, 'CLI 必须公开 Agent 集成移除命令');
const agentIntegrationSource = fs.readFileSync('desktop/cli/src/integration.rs', 'utf8');
assert.match(agentIntegrationSource, /CODEAGENT_PLUGIN_KEY:\s*&str\s*=\s*"marginote@local"/, 'CodeAgent 必须使用独立本地插件键');
assert.match(agentIntegrationSource, /codeagent_installed_path/, 'CodeAgent 必须维护 installed_plugins.json 注册');
assert.match(agentIntegrationSource, /protected_write/, 'CodeAgent 配置写入必须先备份并受保护');
assert.match(agentIntegrationSource, /MARGINOTE_CODEAGENT_DIR/, 'CodeAgent 配置目录必须支持显式环境变量覆盖');
assert.match(agentIntegrationSource, /validate_codeagent_root/, 'CodeAgent 配置根目录必须在写入前校验');
assert.match(agentIntegrationSource, /"updateAvailable"/, 'CodeAgent 状态必须报告插件版本更新');
assert.match(agentIntegrationSource, /"previousCacheRetained"/, 'CodeAgent 升级必须明确保留旧版本缓存');

const tauriConfig = JSON.parse(fs.readFileSync('desktop/src-tauri/tauri.conf.json', 'utf8'));
assert.equal(tauriConfig.app.windows[0].decorations, false, '桌面窗口应取消独立原生标题栏');
assert.equal(tauriConfig.bundle.windows.nsis.compression, 'zlib', 'Windows 安装器应使用偏安装速度的 zlib');
assert.doesNotMatch(fs.readFileSync('desktop/src-tauri/windows/hooks.nsh', 'utf8'), /TIMEOUT=5000/, 'PATH 广播不得让安装固定等待五秒');
assert.ok(
  JSON.parse(fs.readFileSync('desktop/src-tauri/capabilities/default.json', 'utf8')).permissions.includes('core:window:allow-start-dragging'),
  '无边框窗口必须授权自绘标题区拖动'
);

for (const appPath of ['shared/app.js', 'extension/app.js']) {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /AiProviderCore\.buildChatRequest/, `${appPath} 必须统一构建模型请求`);
  assert.match(source, /AiProviderCore\.createStreamAccumulator/, `${appPath} 必须统一解析流式响应`);
  assert.match(source, /AiProviderCore\.emitUsage/, `${appPath} 必须上报实际或估算 token 用量`);
  assert.doesNotMatch(source, /_origCallAi/, `${appPath} 不应通过运行时猴子补丁替换 callAi`);
  assert.equal((source.match(/async function callAi\(/g) || []).length, 1, `${appPath} 只应有一个 callAi 实现`);
  assert.doesNotMatch(source, /addEventListener\(['"]dblclick['"]/, `${appPath} 双击内容区不得切换编辑/预览模式`);
  assert.match(source, /searchInput['"]\)\.addEventListener\(['"]input['"], debounceUi/, `${appPath} 搜索输入必须防抖`);
  assert.match(source, /applyReadingViewportLayout\(\)/, `${appPath} 阅读模式必须应用真实宽度布局`);
  assert.match(source, /setEditorZoom\(value\)/, `${appPath} 必须通过统一入口应用真实编辑区缩放`);
  assert.match(source, /function rollbackImport\(/, `${appPath} 批量导入失败时必须恢复原数据`);
  assert.match(source, /reader\.onerror\s*=/, `${appPath} 导入必须处理底层文件读取错误`);
  assert.match(source, /validateImportZip\(zip\)/, `${appPath} ZIP 导入必须限制文件数和解压体积`);
  assert.match(source, /stagedVersions/, `${appPath} 历史版本必须在主导入成功后再提交`);
  assert.match(source, /notifyAiConfigChanged\(\)/, `${appPath} 加载或保存模型后必须通知 AI 助手刷新`);
  assert.match(source, /aiConfig\.providers\.some\(provider => provider && provider\.id === aiConfig\.activeId\)/, `${appPath} 必须修复已失效的活动模型 ID`);
}

for (const assistantPath of ['shared/js/assistant.js', 'extension/js/assistant.js']) {
  const source = fs.readFileSync(assistantPath, 'utf8');
  assert.doesNotMatch(source, /ASSISTANT_TOOLS\.sub_agent\s*=/, `${assistantPath} 不应注册无独立权限边界的 sub_agent`);
  assert.match(source, /本轮未授权工具/, `${assistantPath} 必须在运行时拒绝未授权工具`);
  assert.match(source, /等待确认删除操作/, `${assistantPath} 的危险 AI 操作必须等待用户确认`);
  assert.match(source, /role: 'user', content: prompt\.context/, `${assistantPath} 必须把本地数据放在非 system 消息中`);
  assert.match(source, /AssistantCore\.resolvePlanningRequest\(requestText, s\?\.messages \|\| \[\]\)/, `${assistantPath} 必须继承连续确认对应的上一轮动作`);
  assert.match(source, /AssistantCore\.filterAutomaticAttachments\(requestText, buildAssistantTurnAttachments\(\), initialIntent\)/, `${assistantPath} 通用记录不得默认写入当前笔记`);
  assert.match(source, /AssistantCore\.planAssistantTurn\(planningRequest\.text, turnAttachments, ctxK\)/, `${assistantPath} 必须使用修正后的连续对话意图规划本轮`);
  assert.match(source, /turnPlan\.promptToolNames/, `${assistantPath} 必须分离默认授权面与模型工具提示面`);
  assert.match(source, /AssistantCore\.captureTargetDecision/, `${assistantPath} 必须阻止低相关旧笔记被误追加`);
  assert.match(source, /这是明确的写入请求，但你尚未真正调用工具/, `${assistantPath} 必须对只描述不执行的写入请求自动重试`);
  assert.match(source, /AssistantCore\.planDeterministicNoteCapture/, `${assistantPath} 明确记录请求在模型不调用工具时必须由应用兜底落盘`);
  assert.match(source, /deterministicFallback: true/, `${assistantPath} 必须标记确定性兜底写入以便追溯`);
  assert.match(source, /function getAutomaticAssistantContext\(/, `${assistantPath} 必须自动注入当前笔记或待办上下文`);
  assert.match(source, /turnPlan\.maxToolSteps/, `${assistantPath} 必须使用 Skill 的步骤上限`);
  assert.match(source, /AssistantCore\.selectRecentHistory/, `${assistantPath} 必须使用统一且有界的历史窗口`);
  assert.match(source, /AssistantCore\.summarizeToolLogForHistory/, `${assistantPath} 连续对话必须保留上一轮写入目标 ID`);
  assert.match(source, /const requestText = String\(userInput \|\| ''\)\.trim\(\)/, `${assistantPath} 必须使用记录模式转换后的实际请求规划权限`);
  assert.match(source, /AssistantCore\.parseAssistantReply/, `${assistantPath} 必须使用共享且有 action 预算的响应解析器`);
  assert.match(source, /AssistantCore\.toolCallSignature/, `${assistantPath} 必须检测重复工具调用`);
  assert.match(source, /AssistantCore\.toolResultForContext/, `${assistantPath} 必须使用统一工具结果压缩`);
  assert.match(source, /AssistantCore\.assistantFailureReply/, `${assistantPath} 必须使用统一错误降级`);
  assert.match(source, /PromptCore\.buildAssistantPrompt/, `${assistantPath} 必须使用统一 Prompt 构建器`);
  assert.doesNotMatch(source, /你是 Marginote 本地笔记应用的 AI 助手/, `${assistantPath} 不应复制内置系统 Prompt`);
  assert.doesNotMatch(source, /function (?:parseAssistantReply|salvageToolCalls|summarizeActionResult|compressForContext)\s*\(/, `${assistantPath} 不应复制共享助手循环纯逻辑`);
  assert.doesNotMatch(source, /\.flatMap\([\s\S]{0,240}_resolveContentImages/, `${assistantPath} 不得把异步图片解析 Promise 当成图片对象`);
  assert.match(source, /addEventListener\('marginote:ai-config-changed', refreshModelSelect\)/, `${assistantPath} 必须在模型配置异步恢复后刷新下拉框`);
  assert.doesNotMatch(source, /window\.saveAiConfig\s*=/, `${assistantPath} 不应通过替换全局保存函数同步模型下拉框`);
}

const extensionAssistant = fs.readFileSync('extension/js/assistant.js', 'utf8');
assert.doesNotMatch(extensionAssistant, /historyWindow/, '扩展端不应恢复到最多 200 条消息的独立历史窗口');
assert.doesNotMatch(extensionAssistant, /_ctxLimit\(20, 300, 300\)/, '扩展端不应把最多 300 篇笔记摘要直接发送给模型');

const promptCore = fs.readFileSync('shared/js/assistant-prompt-core.js', 'utf8');
assert.match(promptCore, /skill\.promptRules/, '共享 Prompt 构建器必须注入 Skill 专属规则');
assert.match(promptCore, /不可信数据/, '共享 Prompt 构建器必须声明本地数据边界');
assert.match(promptCore, /AssistantCore\.selectRelevantMemories/, '共享 Prompt 构建器必须只选择本轮相关记忆');
