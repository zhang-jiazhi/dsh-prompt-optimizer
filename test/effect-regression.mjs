// 效果回归：拿真实模型打优化端点，逐条断言「该保留的还在、不该出现的没出现」。
//
// 与 host-smoke.mjs 的分工：host-smoke 用替身验证宿主行为与守卫逻辑（确定性、
// 进 npm test）；本脚本验证模板的真实优化效果（非确定性、需真模型与运行中的
// web 实例，因此单独跑）。
//
// 用法：node test/effect-regression.mjs
// 退出码：0 = 全部命中；1 = 有失败用例或端点不可用。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'effect-regression.json');
const payload = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const endpoint = payload.endpoint;
const timeoutMs = 180_000;

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

function evaluate(testCase, text) {
	const missing = testCase.mustContain.filter((needle) => !text.includes(needle));
	const forbidden = testCase.mustNotContain.filter((needle) => text.includes(needle));
	return { missing, forbidden, passed: missing.length === 0 && forbidden.length === 0 };
}

async function attempt(testCase) {
	try {
		const result = await optimize(testCase.templateId, testCase.draft);
		if (result.ok !== true) throw new Error(`优化失败：${result.error ?? 'unknown'}`);
		return evaluate(testCase, String(result.text ?? ''));
	} catch (error) {
		return { missing: [], forbidden: [], passed: false, error: error.message };
	}
}

let failures = 0;
const rows = [];

for (const testCase of payload.cases) {
	process.stdout.write(`· ${testCase.id} … `);
	let verdict = await attempt(testCase);
	let attempts = 1;
	// 模型输出有采样波动（默认 temperature 0.3），单次失败不足以判定回归：
	// 失败后再跑一次，两次都失败才算真失败。不重试只会让回归集产生假阴性，
	// 而一个会误报的回归集最终没人看。网络/HTTP 错误不重试（那是环境问题，
	// 重试没有意义，等下次跑即可）。
	if (!verdict.passed && verdict.error === undefined) {
		verdict = await attempt(testCase);
		attempts = 2;
	}
	if (!verdict.passed) failures += 1;
	rows.push({ id: testCase.id, attempts, ...verdict });
	const suffix = verdict.error === undefined ? '' : ` (${verdict.error})`;
	console.log(verdict.passed ? `PASS${attempts > 1 ? '（重试后）' : ''}` : `FAIL${suffix}`);
	if (!verdict.passed) {
		if (verdict.missing.length > 0) console.log(`    缺少: ${verdict.missing.join('、')}`);
		if (verdict.forbidden.length > 0) console.log(`    不该出现: ${verdict.forbidden.join('、')}`);
	}
}

const total = payload.cases.length;
const passed = total - failures;
const retried = rows.filter((row) => row.attempts > 1).length;
console.log(`\n效果回归：${passed}/${total} 通过${retried > 0 ? ` · ${retried} 条经过重试` : ''}`);
console.log(rows.map((row) => `${row.passed ? '✓' : '✗'} ${row.id}${row.attempts > 1 ? ' (×2)' : ''}`).join('\n'));
process.exit(failures === 0 ? 0 : 1);
