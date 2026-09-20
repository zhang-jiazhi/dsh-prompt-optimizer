// 效果回归：拿真实模型打优化端点，按采样统计通过率；可选跑「下游执行」对比。
//
// 与 host-smoke.mjs 的分工：host-smoke 用替身验证宿主行为与守卫逻辑（确定性、
// 进 npm test）；本脚本验证模板的真实优化效果（非确定性、需真模型与运行中的
// web 实例，因此单独跑）。
//
// 0.7.0 改动：
//   - 每条用例按 sampling 次独立采样并报告 x/N 通过率；不再「失败重跑一次算通过」
//     ——那会把 50% 的间歇性失败洗成 PASS；
//   - 断言失败按「缺什么 / 多什么」逐条打印，并在结尾报告模板覆盖率；
//   - 新增 downstream 用例：把原文与优化文分别交给执行模型做同一件事，用确定性
//     断言比较结果——优化器删掉用户约束时，这里会以「执行结果不合规」暴露出来。
//
// 用法：
//   node test/effect-regression.mjs                 # 用 fixtures 里的 sampling
//   node test/effect-regression.mjs --sampling=1    # 便宜跑一遍
//   DPO_EVAL_ENDPOINT=... DPO_EVAL_MODEL=... node test/effect-regression.mjs
// 退出码：0 = 全部达标；1 = 有失败用例或端点不可用。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES } from '../lib/templates.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'effect-regression.json');
const payload = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const endpoint = process.env.DPO_EVAL_OPTIMIZE_ENDPOINT || payload.endpoint;
const timeoutMs = 180_000;

/** CLI 覆盖采样次数：调试/省钱时用 --sampling=1。 */
function cliSampling() {
	const arg = process.argv.find((item) => item.startsWith('--sampling='));
	if (arg === undefined) return null;
	const value = Number.parseInt(arg.slice('--sampling='.length), 10);
	return Number.isFinite(value) && value > 0 ? value : null;
}

const sampling = cliSampling() ?? payload.sampling ?? 1;
const minPassRate = typeof payload.minPassRate === 'number' ? payload.minPassRate : 1;

/** 下游执行端点：默认留空 = 跳过 downstream 用例（不需要额外凭据也能跑文本回归）。 */
const execute = {
	endpoint: process.env.DPO_EVAL_ENDPOINT || payload.execute?.endpoint || '',
	model: process.env.DPO_EVAL_MODEL || payload.execute?.model || '',
	apiKey: process.env[payload.execute?.apiKeyEnv || 'DPO_EVAL_API_KEY'] || '',
	system: payload.execute?.system || '你是一个助手，按用户请求完成工作。',
};

async function optimize(templateId, text) {
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ templateId, text }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

/** 文本断言：mustContain 必须全中；mustContainAny 至少中一条；mustNotContain 一条都不许有。 */
function evaluate(testCase, text) {
	const missing = (testCase.mustContain ?? []).filter((needle) => !text.includes(needle));
	const anyOf = testCase.mustContainAny ?? [];
	if (anyOf.length > 0 && !anyOf.some((needle) => text.includes(needle))) {
		missing.push(`任一：${anyOf.join(' / ')}`);
	}
	const forbidden = (testCase.mustNotContain ?? []).filter((needle) => text.includes(needle));
	return { missing, forbidden, passed: missing.length === 0 && forbidden.length === 0 };
}

/** 独立采样 N 次，返回每次的判定（不重试、不掩盖波动）。 */
async function sampleCase(testCase, times) {
	const attempts = [];
	for (let index = 0; index < times; index += 1) {
		try {
			const result = await optimize(testCase.templateId, testCase.draft);
			if (result.ok !== true) {
				attempts.push({ passed: false, error: `优化失败：${result.error ?? 'unknown'}` });
				continue;
			}
			attempts.push(evaluate(testCase, String(result.text ?? '')));
		} catch (error) {
			attempts.push({ passed: false, error: error.message });
		}
	}
	return attempts;
}

/** 下游执行的确定性断言：子串 + 行数 + 字数。 */
function evaluateExecution(checks, text) {
	const missing = (checks.mustContain ?? []).filter((needle) => !text.includes(needle));
	const forbidden = (checks.mustNotContain ?? []).filter((needle) => text.includes(needle));
	const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
	if (typeof checks.maxLines === 'number' && lines.length > checks.maxLines) {
		forbidden.push(`行数 ${lines.length} > ${checks.maxLines}`);
	}
	if (typeof checks.maxChars === 'number' && text.trim().length > checks.maxChars) {
		forbidden.push(`字数 ${text.trim().length} > ${checks.maxChars}`);
	}
	return { missing, forbidden, passed: missing.length === 0 && forbidden.length === 0 };
}

async function executePrompt(prompt) {
	const headers = { 'content-type': 'application/json' };
	if (execute.apiKey !== '') headers.authorization = `Bearer ${execute.apiKey}`;
	const response = await fetch(execute.endpoint, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			model: execute.model,
			temperature: 0,
			max_tokens: 700,
			messages: [
				{ role: 'system', content: execute.system },
				{ role: 'user', content: prompt },
			],
		}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`执行端点 HTTP ${response.status}`);
	const data = await response.json();
	const content = data?.choices?.[0]?.message?.content;
	if (typeof content !== 'string' || content.trim() === '') throw new Error('执行端点没有返回文本');
	return content;
}

/** 同一条任务分别用原文与优化文执行一次，比较执行结果是否合规。 */
async function runDownstream(testCase) {
	const optimizedResult = await optimize(testCase.templateId, testCase.draft);
	if (optimizedResult.ok !== true) {
		return { passed: false, error: `优化失败：${optimizedResult.error ?? 'unknown'}` };
	}
	const optimized = String(optimizedResult.text ?? '');
	const task = String(testCase.task ?? '');
	const rawAnswer = await executePrompt(`${task}\n\n---\n用户请求：\n${testCase.draft}`);
	const optimizedAnswer = await executePrompt(`${task}\n\n---\n用户请求：\n${optimized}`);
	const raw = evaluateExecution(testCase.checks ?? {}, rawAnswer);
	const after = evaluateExecution(testCase.checks ?? {}, optimizedAnswer);
	return { passed: after.passed, raw, optimized: after };
}

const textCases = payload.cases.filter((testCase) => testCase.kind !== 'downstream');
const downstreamCases = payload.cases.filter((testCase) => testCase.kind === 'downstream');
const coveredTemplates = new Set();
const rows = [];
let failures = 0;
let skipped = 0;

for (const testCase of textCases) {
	process.stdout.write(`· ${testCase.id} … `);
	coveredTemplates.add(testCase.templateId);
	const attempts = await sampleCase(testCase, sampling);
	const passed = attempts.filter((attempt) => attempt.passed).length;
	const infraErrors = attempts.filter((attempt) => attempt.error !== undefined);
	const ok = passed / attempts.length >= minPassRate && infraErrors.length === 0;
	if (!ok) failures += 1;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${passed}/${attempts.length}`);
	if (!ok) {
		const firstBad = attempts.find((attempt) => !attempt.passed) ?? {};
		if (firstBad.error !== undefined) console.log(`    ${firstBad.error}`);
		if ((firstBad.missing ?? []).length > 0) console.log(`    缺少: ${firstBad.missing.join('、')}`);
		if ((firstBad.forbidden ?? []).length > 0) console.log(`    不该出现: ${firstBad.forbidden.join('、')}`);
	}
	rows.push({ id: testCase.id, kind: 'text', ok, passed, attempts: attempts.length });
}

if (downstreamCases.length > 0) {
	if (execute.endpoint === '' || execute.model === '') {
		skipped = downstreamCases.length;
		console.log(`\n↓ 跳过 ${downstreamCases.length} 条下游用例：未配置执行端点（DPO_EVAL_ENDPOINT / DPO_EVAL_MODEL）`);
	} else {
		for (const testCase of downstreamCases) {
			process.stdout.write(`· ${testCase.id} … `);
			coveredTemplates.add(testCase.templateId);
			try {
				const result = await runDownstream(testCase);
				if (!result.passed) failures += 1;
				const verdict = (value) => (value === true ? '合规' : value === false ? '不合规' : '未跑');
				console.log(`${result.passed ? 'PASS' : 'FAIL'}（原文 ${verdict(result.raw?.passed)} → 优化后 ${verdict(result.optimized?.passed)}）`);
				if (!result.passed) {
					if (result.error !== undefined) console.log(`    ${result.error}`);
					if ((result.optimized?.missing ?? []).length > 0) console.log(`    缺少: ${result.optimized.missing.join('、')}`);
					if ((result.optimized?.forbidden ?? []).length > 0) console.log(`    不该出现: ${result.optimized.forbidden.join('、')}`);
				}
				rows.push({ id: testCase.id, kind: 'downstream', ok: result.passed, raw: result.raw?.passed, optimized: result.optimized?.passed });
			} catch (error) {
				failures += 1;
				console.log(`FAIL (${error.message})`);
				rows.push({ id: testCase.id, kind: 'downstream', ok: false });
			}
		}
	}
}

const total = payload.cases.length;
const attempted = total - skipped;
const passedCases = attempted - failures;
const coverage = `${coveredTemplates.size}/${TEMPLATES.length}`;
console.log(`\n效果回归：${passedCases}/${attempted} 达标${skipped > 0 ? ` · 跳过 ${skipped} 条` : ''} · 模板覆盖 ${coverage} · 采样 ${sampling} 次/条 · 达标线 ${Math.round(minPassRate * 100)}%`);
console.log(rows.map((row) => {
	if (row.kind !== 'downstream') return `${row.ok ? '✓' : '✗'} ${row.id} ${row.passed}/${row.attempts}`;
	const verdict = (value) => (value === true ? '合规' : value === false ? '不合规' : '未跑');
	return `${row.ok ? '✓' : '✗'} ${row.id}（原文 ${verdict(row.raw)} → 优化后 ${verdict(row.optimized)}）`;
}).join('\n'));
if (coveredTemplates.size < TEMPLATES.length) {
	console.log(`\n⚠ 模板覆盖不全：${TEMPLATES.length - coveredTemplates.size} 个模板没有效果样本（host-smoke ㉓ 会直接判失败）`);
}
process.exit(failures === 0 ? 0 : 1);
