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
}

for (const assistantPath of ['shared/js/assistant.js', 'extension/js/assistant.js']) {
  const source = fs.readFileSync(assistantPath, 'utf8');
  assert.doesNotMatch(source, /ASSISTANT_TOOLS\.sub_agent\s*=/, `${assistantPath} 不应注册无独立权限边界的 sub_agent`);
  assert.match(source, /本轮未授权工具/, `${assistantPath} 必须在运行时拒绝未授权工具`);
  assert.match(source, /等待确认删除操作/, `${assistantPath} 的危险 AI 操作必须等待用户确认`);
  assert.match(source, /role: 'user', content: prompt\.context/, `${assistantPath} 必须把本地数据放在非 system 消息中`);
  assert.match(source, /AssistantCore\.planAssistantTurn\(requestText, turnAttachments, ctxK\)/, `${assistantPath} 必须使用含自动上下文的本轮规划器`);
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
}

const extensionAssistant = fs.readFileSync('extension/js/assistant.js', 'utf8');
assert.doesNotMatch(extensionAssistant, /historyWindow/, '扩展端不应恢复到最多 200 条消息的独立历史窗口');
assert.doesNotMatch(extensionAssistant, /_ctxLimit\(20, 300, 300\)/, '扩展端不应把最多 300 篇笔记摘要直接发送给模型');

const promptCore = fs.readFileSync('shared/js/assistant-prompt-core.js', 'utf8');
assert.match(promptCore, /skill\.promptRules/, '共享 Prompt 构建器必须注入 Skill 专属规则');
assert.match(promptCore, /不可信数据/, '共享 Prompt 构建器必须声明本地数据边界');
assert.match(promptCore, /AssistantCore\.selectRelevantMemories/, '共享 Prompt 构建器必须只选择本轮相关记忆');
