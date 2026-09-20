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
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

function listTemplateFiles() {
	try {
		return readdirSync(TEMPLATE_DIR).filter((file) => file.endsWith('.md')).sort();
	} catch (error) {
		throw new Error(`dsh-prompt-optimizer: 模板目录不可读 ${TEMPLATE_DIR}: ${error.message}`);
	}
}

/** 共享段目录缺失不算致命：只是没有可展开的 include。 */
function listSharedFiles() {
	try {
		return readdirSync(SHARED_DIR).filter((file) => file.endsWith('.md')).sort();
	} catch {
		return [];
	}
}

/**
 * 逐文件加载：单个模板写坏（JSON 头损坏 / 多个 USER 标记 / include 循环 / id 重复）
 * 只跳过该文件并逐条告警，绝不连坐整个目录——本函数曾在模块导入时直接执行，
 * 一个坏文件会让整个插件加载失败（全站 500，二轮审计 P2）。
 * 只剩「目录不可读 / 没有任何可用模板」这类目录级灾难时才抛，由 tryLoadTemplates 兜底。
 */
function loadTemplates() {
	const files = listTemplateFiles();
	if (files.length === 0) throw new Error(`dsh-prompt-optimizer: 模板目录为空 ${TEMPLATE_DIR}`);

	const parsed = [];
	const failures = [];
	for (const file of files) {
		try {
			parsed.push(parseTemplateFile(file));
		} catch (error) {
			// parseTemplateFile 的错误信息自带文件名与原因，逐条列出即可定位。
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	for (const failure of failures) console.warn(`dsh-prompt-optimizer: 模板文件加载失败，已跳过：${failure}`);
	if (parsed.length === 0) throw new Error(`dsh-prompt-optimizer: 模板目录里没有可用的模板文件 ${TEMPLATE_DIR}`);

	parsed.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
	const seen = new Set();
	const templates = [];
	for (const template of parsed) {
		if (seen.has(template.id)) {
			console.warn(`dsh-prompt-optimizer: 模板 id 重复，已跳过后者：${template.id}`);
			continue;
		}
		seen.add(template.id);
		templates.push(template);
	}
	return templates.map(({ order: _order, ...template }) => template);
}

/** 目录级兜底：loadTemplates 抛错（目录不可读 / 全部文件损坏）时不向上传播，返回 null。 */
function tryLoadTemplates() {
	try {
		return loadTemplates();
	} catch (error) {
		console.warn(error instanceof Error ? error.message : String(error));
		return null;
	}
}

/** 模板目录指纹：任一文件 mtime 变化都会让缓存失效。 */
function computeStamp() {
	const parts = [];
	for (const [dir, files] of [[TEMPLATE_DIR, listTemplateFiles()], [SHARED_DIR, listSharedFiles()]]) {
		for (const file of files) {
			try {
				parts.push(file, statSync(join(dir, file)).mtimeMs);
			} catch {
				parts.push(file, 0);
			}
		}
	}
	return parts.join('|');
}

let cachedTemplates = null;
let cachedStamp = null;
/** 最近一次成功加载的快照：mtime 重解析失败时降级用它，而不是让优化端点 500。 */
let lastGoodTemplates = null;

/**
 * 取模板目录（按 mtime 失效）。
 *
 * 刻意不在模块导入时冻结：模板是数据，改完 `templates/*.md` 应当下次请求就
 * 生效，而不是必须热重载或重启 `dsh web`（本项目多次踩到——进程启动后改模板，
 * 线上仍是旧内容，连排查都得先比对进程启动时间与文件 mtime）。代价是每次调用
 * 做一次目录扫描 + stat，相对一次模型调用可忽略。
 */
export function getTemplates() {
	const stamp = computeStamp();
	if (cachedTemplates === null || stamp !== cachedStamp) {
		const loaded = tryLoadTemplates();
		if (loaded !== null) {
			cachedTemplates = loaded;
			cachedStamp = stamp;
			lastGoodTemplates = loaded;
		} else if (lastGoodTemplates !== null) {
			// 重解析失败（目录被清空 / 全部文件损坏）：降级用上一份成功快照并告警，
			// 不让一次坏编辑打死整个插件。刻意把 cachedStamp 推进到当前指纹——
			// 坏状态只告警一次，修好文件后 mtime 变化会自然触发下一次重载。
			cachedTemplates = lastGoodTemplates;
			cachedStamp = stamp;
			console.warn('dsh-prompt-optimizer: 模板目录重载失败，继续使用上一次成功加载的模板快照');
		} else {
			// 首次加载就失败的最坏情况：空目录而不是抛错，插件加载与路由照常。
			cachedTemplates = [];
			cachedStamp = stamp;
		}
	}
	return cachedTemplates;
}

/** 初始快照（兼容既有 import）：导入时坏目录不再抛错，最坏为空数组。
 *  需要热加载语义请用 getTemplates()。 */
export const TEMPLATES = getTemplates();

export { TEMPLATE_DIR };
