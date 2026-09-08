/**
 * 模板目录：从 `templates/*.md` 加载（每个模板一个文件），公共段用
 * `{{include:name}}` 引用 `templates/_shared/*.md`。
 *
 * 文件格式：
 *   第一行是 JSON 头：{"id","name","desc","category","order"}
 *   其余是模板正文；正文里的 `<!-- USER -->` 把 system / user 两段分开。
 *   没有该标记的模板是字符串模板：system = 全文，user = 用户输入草稿。
 *
 * 变量约定（请求时由宿主 renderVars 渲染）：
 *   `{{originalPrompt}}` / `{{json:originalPrompt}}` / `{{对话上下文}}`
 *   `{{include:…}}` 只在加载时展开，绝不会出现在发给模型的请求里。
 *
 * 外置化的目的：模板正文可读、可 diff、可单独审阅；公共理念段（INTENT_RULES、
 * CTX_CORE、CTX_USER 等）仍然只有一份，改总纲只改一个文件。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const SHARED_DIR = join(TEMPLATE_DIR, '_shared');
const USER_MARKER = '<!-- USER -->';
const INCLUDE_PATTERN = /\{\{include:([a-z0-9-]+)\}\}/g;
const TEMPLATE_ID_PATTERN = /^[a-z0-9-]+$/;
const CATEGORIES = new Set(['basic', 'context', 'image']);

function readTemplateFile(name, file) {
	try {
		return readFileSync(file, 'utf8');
	} catch (error) {
		throw new Error(`dsh-prompt-optimizer: 模板文件读取失败 ${name} (${file}): ${error.message}`);
	}
}

/** 展开 {{include:name}}；带循环检测，循环时抛出可定位的错误。 */
function expandIncludes(text, origin, seen = new Set()) {
	return text.replace(INCLUDE_PATTERN, (_match, name) => {
		if (seen.has(name)) {
			throw new Error(`dsh-prompt-optimizer: 模板 include 循环：${origin} -> ${name}`);
		}
		const body = readTemplateFile(name, join(SHARED_DIR, `${name}.md`));
		const next = new Set(seen);
		next.add(name);
		return expandIncludes(body, `${origin} -> ${name}`, next);
	});
}

function parseTemplateFile(fileName) {
	const source = readTemplateFile(fileName, join(TEMPLATE_DIR, fileName));
	const newline = source.indexOf('\n');
	const headerLine = newline === -1 ? source : source.slice(0, newline);
	const rawBody = newline === -1 ? '' : source.slice(newline + 1);

	let header;
	try {
		header = JSON.parse(headerLine);
	} catch (error) {
		throw new Error(`dsh-prompt-optimizer: 模板头部不是合法 JSON ${fileName}: ${error.message}`);
	}
	const { id, name, desc, category, order } = header ?? {};
	if (typeof id !== 'string' || !TEMPLATE_ID_PATTERN.test(id)) throw new Error(`dsh-prompt-optimizer: 模板 id 非法 ${fileName}: ${String(id)}`);
	if (typeof name !== 'string' || name.trim() === '') throw new Error(`dsh-prompt-optimizer: 模板 name 缺失 ${fileName}`);
	if (typeof desc !== 'string') throw new Error(`dsh-prompt-optimizer: 模板 desc 缺失 ${fileName}`);
	if (typeof category !== 'string' || !CATEGORIES.has(category)) throw new Error(`dsh-prompt-optimizer: 模板 category 非法 ${fileName}: ${String(category)}`);
	if (typeof order !== 'number' || !Number.isFinite(order)) throw new Error(`dsh-prompt-optimizer: 模板 order 非法 ${fileName}: ${String(order)}`);

	const body = expandIncludes(rawBody, fileName);
	if (body.includes('{{include:')) throw new Error(`dsh-prompt-optimizer: 模板 include 未展开 ${fileName}`);

	const parts = body.split(USER_MARKER);
	if (parts.length > 2) throw new Error(`dsh-prompt-optimizer: 模板出现多个 ${USER_MARKER} ${fileName}`);
	// 文件约定：标记单独占一行，两侧各有一个换行；这两个换行只是排版，
	// 不属于模板正文，切分时各去掉一个，保证与原模板逐字一致。
	const content = parts.length === 2
		? [
			{ role: 'system', content: parts[0].endsWith('\n') ? parts[0].slice(0, -1) : parts[0] },
			{ role: 'user', content: parts[1].startsWith('\n') ? parts[1].slice(1) : parts[1] },
		]
		: parts[0];

	return { id, name, desc, category, order, content };
}

function loadTemplates() {
	let files;
	try {
		files = readdirSync(TEMPLATE_DIR).filter((file) => file.endsWith('.md')).sort();
	} catch (error) {
		throw new Error(`dsh-prompt-optimizer: 模板目录不可读 ${TEMPLATE_DIR}: ${error.message}`);
	}
	if (files.length === 0) throw new Error(`dsh-prompt-optimizer: 模板目录为空 ${TEMPLATE_DIR}`);

	const templates = files.map(parseTemplateFile).sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
	const seen = new Set();
	for (const template of templates) {
		if (seen.has(template.id)) throw new Error(`dsh-prompt-optimizer: 模板 id 重复：${template.id}`);
		seen.add(template.id);
	}
	return templates.map(({ order: _order, ...template }) => template);
}

export const TEMPLATES = loadTemplates();
export { TEMPLATE_DIR };
