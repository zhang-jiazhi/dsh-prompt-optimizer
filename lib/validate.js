/**
 * 输出守卫：模板自检之外的第二道确定性防线。
 *
 * 设计取舍：这里只做「检测 + 轻量规范化」，默认不自动重试。重试会让一次
 * 优化的延迟与成本翻倍，而模板本身已经写了大量自检规则；先把问题变成
 * 用户可见的告警，再根据真实数据决定哪些告警值得升级成重试。
 *
 * 覆盖范围只限「任务指令类」模板（基础类 3 个 + 上下文类 3 个）：
 *   - 角色卡模板（general-optimize 等）本来就该输出 # Role，不适用；
 *   - 图像类模板有自己的 JSON/占位符保真协议，也不套用任务指令的体量规则；
 *   - SOUL 模板是人格文件，不是任务指令。
 */

/** 待优化草稿里的变量占位符（{{name}}），用于校验输出是否逐字保留。 */
const PLACEHOLDER_PATTERN = /\{\{[^{}\n]{1,80}\}\}/g;

/** 只对这 6 个模板做任务指令语义的守卫。 */
const TASK_LIKE_TEMPLATE_IDS = new Set([
	'user-task-optimize',
	'user-task-planning',
	'secure-reverse-optimize',
	'context-message-optimize',
	'context-analytical-optimize',
	'context-output-format-optimize',
]);

/** 角色卡结构：任务指令模板里出现即为跑偏。 */
const ROLE_CARD_PATTERN = /^\s*#{1,3}\s*(?:Role|Profile|Skills|Initialization)\b/im;

/** 模型偶尔加在正文开头的引导词。 */
const LEADING_PREFIX_PATTERN = /^(?:以下(?:是|为)?\s*)?(?:优化后(?:的提示词|的版本)?|优化结果|改写后(?:的提示词)?|优化后的版本|Optimized(?:\s+prompt)?)\s*[:：]\s*/i;

/** 短草稿的输出体量上限：超过就提醒可能注水。 */
const VERBOSE_MIN_DRAFT_CHARS = 200;
const VERBOSE_MIN_OUTPUT_CHARS = 1200;
const VERBOSE_RATIO = 8;

/** 提取草稿里出现过的全部变量占位符（去重、保持出现顺序）。 */
export function extractPlaceholders(text) {
	const seen = new Set();
	const found = [];
	for (const match of String(text ?? '').matchAll(PLACEHOLDER_PATTERN)) {
		if (!seen.has(match[0])) {
			seen.add(match[0]);
			found.push(match[0]);
		}
	}
	return found;
}

/** 去掉模型偶尔加在开头的「优化后：」引导词；只在开头匹配，正文里的同名文字不动。 */
export function stripLeadingPrefix(text) {
	return String(text ?? '').replace(LEADING_PREFIX_PATTERN, '');
}

/** 该模板是否属于「用户对助手说的话」这一类（需要任务指令守卫）。 */
export function isTaskLikeTemplate(template) {
	return TASK_LIKE_TEMPLATE_IDS.has(template?.id);
}

/**
 * 校验并轻量规范化一次优化结果。
 * @param {{ template: { id: string }, draft: string, output: string }} input
 * @returns {{ text: string, warnings: Array<{ code: string, message: string }> }}
 */
export function validateOptimizedOutput({ template, draft, output }) {
	let text = String(output ?? '');
	const warnings = [];

	const stripped = stripLeadingPrefix(text);
	if (stripped !== text) {
		text = stripped;
		warnings.push({ code: 'prefix-stripped', message: '已自动去掉“优化后：”之类的前缀' });
	}

	if (isTaskLikeTemplate(template)) {
		const missing = extractPlaceholders(draft).filter((placeholder) => !text.includes(placeholder));
		if (missing.length > 0) {
			const shown = missing.slice(0, 3).join('、');
			warnings.push({
				code: 'placeholder-missing',
				message: `有 ${missing.length} 个变量占位符未保留：${shown}${missing.length > 3 ? '…' : ''}`,
			});
		}
		if (ROLE_CARD_PATTERN.test(text)) {
			warnings.push({
				code: 'role-card-leak',
				message: '输出疑似角色卡（# Role / ## Profile），与任务指令身份不符',
			});
		}
		const draftLength = String(draft ?? '').trim().length;
		if (draftLength > 0 && draftLength <= VERBOSE_MIN_DRAFT_CHARS
			&& text.length > Math.max(VERBOSE_MIN_OUTPUT_CHARS, draftLength * VERBOSE_RATIO)) {
			warnings.push({
				code: 'verbose',
				message: `输出 ${text.length} 字，约为原文的 ${Math.round(text.length / draftLength)} 倍，注意是否注水`,
			});
		}
	}

	return { text, warnings };
}
