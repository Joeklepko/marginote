const core = require('../shared/js/editor-ui-core.js');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log('✓', name); }
  else { failed++; console.error('✗ FAIL', name); }
}

check('14 寸等窄编辑区保持折叠', !core.shouldExpandEditorActions(980));
check('21/24 寸等宽编辑区展开全部操作', core.shouldExpandEditorActions(1350));
check('展开阈值边界稳定', core.shouldExpandEditorActions(core.ACTIONS_EXPANDED_MIN_WIDTH));
check('默认窄窗口工具栏换行避免裁切', core.shouldUseCompactToolbar(704));
check('14 寸窗口为缩放控件安全换行', core.shouldUseCompactToolbar(968));

check('缩放步进为 10%', core.nextEditorZoom(1, 0.1) === 1.1);
check('缩放下限为 50%', core.nextEditorZoom(0.5, -0.1) === 0.5);
check('缩放上限为 300%', core.nextEditorZoom(3, 0.1) === 3);
check('非法缩放值回退到 100%', core.normalizeEditorZoom('bad') === 1);

const reading = core.readingLayout(1920);
check('全屏阅读使用约 88% 视口宽度', reading.width === 1689.6);
check('全屏阅读正文宽于普通编辑区', reading.contentWidth === 1516.8);
check('超宽屏阅读宽度有合理上限', core.readingLayout(3840).width === 1920);

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
