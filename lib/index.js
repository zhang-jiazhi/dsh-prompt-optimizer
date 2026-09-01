/**
 * @local/dsh-prompt-optimizer — host half.
 *
 * 移植自 linshenkx/prompt-optimizer（AGPL-3.0）的核心优化模板，去冗余后仅保留：
 * 三类模板（基础 / 上下文 / 图像）的一次性提示词优化。优化调用走宿主的
 * `ctx.llm` 服务（模型路由跟随 DSH 默认模型，或用设置页里配置的 provider/model），
 * 不直连任何 API、不触碰凭据。
 *
 * 路由（loopback + same-origin 闸，同 dsh-session-delete 惯例）：
 *   GET  /api/dsh-prompt-optimizer/templates → 模板目录（客户端下拉用）
 *   POST /api/dsh-prompt-optimizer/optimize  { templateId, text, sessionId? }
 *     → { ok, text, ms, contextChars }；客户端断开即中止模型调用
 *
 * 设置：向 `ctx.settings` 注册 `dsh-prompt-optimizer` 命名空间，全部参数
 * （模型覆盖 / 温度 / 输出上限 / 超时 / 上下文预算）在 设置 → 插件 面板调整，
 * 即时生效；宿主无 settings 服务时自动跳过，走 schema 默认值。
 */
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { TEMPLATES } from './templates.js';

/** Stable cordis plugin name. */
export const name = 'dsh-prompt-optimizer';

/** Services required before the routes mount. */
export const inject = ['webServer', 'llm'];

/** 插件设置 schema（设置 → 插件 → 提示词优化器）。 */
export const Config = z.object({
	provider: z.string().default('').description('模型提供方（留空 = 跟随 DSH 默认模型）'),
	model: z.string().default('').description('模型 ID（留空 = 跟随 DSH 默认模型；与提供方需同时配置）'),
	temperature: z.number().min(0).max(2).step(0.1).default(0.3).description('采样温度'),
	reasoningEffort: z.string().default('inherit').description('推理强度：inherit=跟随模型默认（最稳），off/low/medium/high/max 可加速；各家模型支持的档位不同，模型拒绝该档位时本次优化自动回退到模型默认档位重试'),
	maxTokens: z.natural().default(8192).description('单次输出 token 上限（推理型模型会把思考 token 计入同一预算，留足余量；预算被思考吃光时本插件会按更宽预算自动重试一次）'),
	timeoutMs: z.natural().default(120000).description('单次优化超时（毫秒）'),
	maxInputChars: z.natural().default(8000).description('待优化文本长度上限（字符，超长拒绝）'),
	contextMaxMessages: z.natural().default(12).description('上下文类模板携带的最近对话条数'),
	contextMaxChars: z.natural().default(4000).description('上下文文本总长上限（字符）'),
}).description('提示词优化器（移植自 prompt-optimizer）');

/** 模板 id → 定义。 */
const TEMPLATE_MAP = new Map(TEMPLATES.map((t) => [t.id, t]));

/** 输入框目录接口无缓存，仅防误用的输入长度兜底。 */
const MAX_INPUT_CHARS_FALLBACK = 8000;
const MAX_TEMPLATE_ID_CHARS = 256;

/** 上下文提取只看会话尾部这么多个事件（超长会话不必全量深遍历）。 */
const EVENT_TAIL_WINDOW = 80;

/** 尾窗内最多收集的对话条数上限（防御畸形结构，正常远够用）。 */
const DIALOG_COLLECT_CAP = 200;

/** 设置值钳制：非正数/非有限值一律回落默认（设置页清空数字框会提交空串→0）。 */
function numOr(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 上下文预算类允许 0（=关闭），仅拒绝负数/非有限值。 */
function numAtLeast0(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveIntOr(value, fallback) {
	return Math.max(1, Math.floor(numOr(value, fallback)));
}

function nonNegativeIntOr(value, fallback) {
	return Math.max(0, Math.floor(numAtLeast0(value, fallback)));
}

/** setTimeout 在 Node 与浏览器都能接受的最大安全延迟。 */
const MAX_TIMEOUT_MS = 2_147_483_647;

function timeoutOr(value, fallback) {
	const number = numOr(value, fallback);
	return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(number)));
}

/** 创建可清理的请求 deadline，避免每次完成后留下不可取消的 AbortSignal.timeout 定时器。 */
function createDeadline(parentSignal, timeoutMs) {
	const controller = new AbortController();
	const onParentAbort = () => {
		if (!controller.signal.aborted) controller.abort(abortReason(parentSignal));
	};
	parentSignal.addEventListener('abort', onParentAbort, { once: true });
	if (parentSignal.aborted) onParentAbort();
	const timer = setTimeout(() => {
		const error = new Error('优化超时');
		error.name = 'TimeoutError';
		controller.abort(error);
	}, timeoutMs);
	return {
		signal: controller.signal,
		dispose() {
			clearTimeout(timer);
			parentSignal.removeEventListener('abort', onParentAbort);
		},
	};
}

/** 输出预算默认值（与 Config schema 默认保持一致）。 */
const DEFAULT_MAX_TOKENS = 8192;

/** 「纯烧预算」自动重试的输出上限天花板：只救一次，不无限放大成本。 */
const BUDGET_RETRY_CEILING = 32768;

/** 合法的推理强度档位（与 settings.yaml reasoningEfforts 键一致）。 */
const REASONING_EFFORTS = new Set(['off', 'low', 'medium', 'high', 'max']);

function isLoopbackRequest(request) {
	const address = request?.socket?.remoteAddress;
	if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
	const headers = request?.headers;
	const host = headers?.host;
	if (typeof host !== 'string') return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false;
	if (headers['sec-fetch-site'] === 'cross-site') return false;
	const origin = headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

function boundedError(error, limit = 512) {
	const text = error instanceof Error ? error.message : String(error);
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function writeJson(res, status, body, extraHeaders) {
	// 客户端取消后 ServerResponse 已 destroyed；不要再尝试写响应，避免适配器
	// 把一次正常取消升级成 write-after-destroy 错误。
	if (res.writableEnded || res.destroyed) return false;
	try {
		const headers = Object.assign({
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
			'x-content-type-options': 'nosniff',
		}, extraHeaders);
		res.writeHead(status, headers);
		res.end(JSON.stringify(body));
		return true;
	} catch (error) {
		if (res.writableEnded || res.destroyed) return false;
		throw error;
	}
}

function abortError(message = '已取消') {
	const error = new Error(message);
	error.name = 'AbortError';
	return error;
}

function abortReason(signal, fallback = '已取消') {
	const reason = signal?.reason;
	return reason instanceof Error ? reason : abortError(fallback);
}

/** 将一个不支持 signal 的 Promise 绑定到请求生命周期，结束后移除监听器。 */
function withAbort(value, signal) {
	if (signal === undefined || signal === null) return Promise.resolve(value);
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener('abort', onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(abortReason(signal));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		Promise.resolve(value).then(
			(result) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			},
			(error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

function readBody(request, limit = 256 * 1024, signal) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let ended = false;
		let settled = false;
		const remove = (event, listener) => {
			if (typeof request.off === 'function') request.off(event, listener);
			else request.removeListener?.(event, listener);
		};
		const cleanup = () => {
			remove('data', onData);
			remove('end', onEnd);
			// Keep the request error listener until the stream's close event: aborting
			// or draining a request can report its error on a later turn.
			remove('aborted', onAborted);
			remove('close', onClose);
			signal?.removeEventListener('abort', onSignalAbort);
		};
		const succeed = (value) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onData = (chunk) => {
			if (settled) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.length;
			if (size > limit) {
				const error = new Error('body too large');
				error.code = 'body-too-large';
				fail(error);
				// Keep the connection usable long enough to return a JSON error. The
				// stream is no longer observed, so resume() drains without retaining data.
				// Destroy is only a fallback for non-Node request shims.
				if (typeof request.resume === 'function') request.resume();
				else request.destroy?.();
				return;
			}
			chunks.push(buffer);
		};
		const onEnd = () => {
			if (settled) return;
			ended = true;
			try {
				succeed(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (error) {
				fail(new Error(`bad JSON: ${error.message}`));
			}
		};
		const onError = (error) => fail(error);
		const onRequestClose = () => {
			// cleanup() deliberately leaves this late error guard in place. Once the
			// stream closes, no further destroy/drain error can be emitted for it.
			remove('error', onError);
			remove('close', onRequestClose);
		};
		const onAborted = () => fail(abortReason(signal, '客户端已断开'));
		const onClose = () => {
			// IncomingMessage 的正常顺序是 end → close；只有 body 尚未结束时，
			// close 才表示上传方提前断开。
			if (!ended) fail(abortReason(signal, '客户端已断开'));
		};
		const onSignalAbort = () => {
			fail(abortReason(signal));
			request.destroy?.();
		};
		request.on('data', onData);
		request.on('end', onEnd);
		request.on('error', onError);
		request.on('aborted', onAborted);
		request.on('close', onClose);
		request.on('close', onRequestClose);
		if (signal !== undefined && signal !== null) {
			signal.addEventListener('abort', onSignalAbort, { once: true });
			if (signal.aborted) onSignalAbort();
		}
	});
}

/** 白名单变量渲染：仅替换模板目录声明的变量，其余 {{…}} 原样保留（多为输出格式示例）。 */
function renderVars(text, vars) {
	return text.replace(/\{\{(json:originalPrompt|originalPrompt|对话上下文)\}\}/g, (_match, key) => {
		// 一次扫描很重要：如果原提示词本身包含 {{originalPrompt}} 或
		// {{对话上下文}}，多次 replace 会再次处理刚插入的用户数据，破坏 JSON
		// 转义结果，甚至把一个字段的内容注入另一个字段。
		if (key === 'json:originalPrompt') return JSON.stringify(vars.originalPrompt);
		return key === 'originalPrompt' ? vars.originalPrompt : vars.context;
	});
}

/**
 * 按模板组装一次模型调用（沿用 linshenkx TemplateProcessor 的语义简化版）：
 * 字符串模板 → system=模板全文，user=原提示词；数组模板 → 渲染变量后
 * 聚合 system 消息，取最后一条 user 消息作为请求正文。
 */
function buildLlmRequest(template, originalPrompt, contextText) {
	const vars = { originalPrompt, context: contextText };
	if (typeof template.content === 'string') {
		return { system: template.content, user: originalPrompt };
	}
	const rendered = template.content.map((m) => ({ role: m.role, content: renderVars(m.content, vars) }));
	const system = rendered.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
	const user = [...rendered].reverse().find((m) => m.role === 'user')?.content;
	return { system, user: user ?? originalPrompt };
}

/** 从消息形对象里提取文本（content 为字符串或 {type:'text'} 块数组）。 */
function messageText(node) {
	const content = node?.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
			.map((b) => b.text)
			.join('');
	}
	return '';
}

/** 有界深度优先收集会话事件里的 user/assistant 文本消息（防御式，不认识的结构一律跳过）。 */
function collectDialogTexts(root, maxMessages) {
	const found = [];
	const seen = new Set();
	const visit = (node, depth) => {
		if (found.length >= maxMessages || depth > 6 || node === null || typeof node !== 'object') return;
		if (seen.has(node)) return;
		seen.add(node);
		if (Array.isArray(node)) {
			for (const item of node) visit(item, depth + 1);
			return;
		}
		const role = node.role;
		if ((role === 'user' || role === 'assistant') && !node.toolCallId && node.source?.kind !== 'tool') {
			const text = messageText(node).trim();
			if (text !== '') {
				found.push({ role, text });
				return;
			}
		}
		for (const key of Object.keys(node)) {
			if (key === 'parent' || key === 'root') continue;
			visit(node[key], depth + 1);
		}
	};
	visit(root, 0);
	return found;
}

/** 从 canonical surface 直接投影消息，排除 tool/result 与非消息生命周期事件。 */
function collectSurfaceDialogTexts(events, maxMessages) {
	const found = [];
	for (const event of events) {
		if (found.length >= maxMessages) break;
		let message = null;
		if (event?.type === 'user/message') message = event.data;
		else if (event?.type === 'assistant/message') message = event.data?.message;
		if (message === null || message?.toolCallId || (message?.role !== 'user' && message?.role !== 'assistant')) continue;
		const text = messageText(message).trim();
		if (text !== '') found.push({ role: message.role, text });
	}
	return found;
}

/** 上下文缺位时的显式标记：留空会让模板看到一段空白，模型只能靠猜。 */
const CONTEXT_NONE = '（本次未携带对话上下文，请只按消息本身改写）';
const CONTEXT_UNAVAILABLE = '（对话上下文不可用：这次没有读到会话记录，请只按消息本身改写）';
const CONTEXT_FIRST_MESSAGE = '（无，本消息是本次对话的第一条消息）';

/** 空上下文结果：contextChars 只统计真实对话字符，占位标记不计入。 */
function emptyContext(marker) {
	return { text: marker, chars: 0 };
}

/**
 * 消毒闭合标签：模板用 <对话上下文>…</对话上下文> 圈定证据边界，
 * 会话里出现的同名闭合标签必须转义，否则一条历史消息就能伪造边界。
 */
function sanitizeContextText(text) {
	return text.replace(/<\/(对话上下文)>/g, '<\\/$1>');
}

/**
 * 上下文类模板的会话背景：读当前会话最近对话（best-effort）。
 * 读不到时返回显式占位标记（不是空串），并让 contextChars 保持 0，
 * 客户端据此提示"本次没带上下文"。
 */
async function gatherContext(ctx, sessionId, cfg, signal) {
	if (!sessionId || cfg.contextMaxMessages <= 0 || cfg.contextMaxChars <= 0) return emptyContext(CONTEXT_NONE);
	const sessionQuery = ctx.get('sessionQuery');
	const readSurface = typeof sessionQuery?.readSurface === 'function';
	if (!readSurface && typeof sessionQuery?.readSession !== 'function') return emptyContext(CONTEXT_UNAVAILABLE);
	try {
		if (signal?.aborted) throw abortReason(signal);
		// Prefer the canonical folded surface: readSession() is a raw log and can
		// still contain messages shadowed by compaction/replacement. Both current
		// DSH readers are non-cancellable, so withAbort bounds this plugin's wait.
		const pending = readSurface
			? sessionQuery.readSurface(sessionId)
			: sessionQuery.readSession(sessionId);
		const snap = await withAbort(pending, signal);
		// 只取尾部事件：消息事件按时间序排列，要最后 contextMaxMessages 条对话，
		// 读尾部 80 个事件足够，避免超长会话每次优化都全量深遍历。
		const events = snap?.events ?? [];
		const tail = events.length > EVENT_TAIL_WINDOW ? events.slice(-EVENT_TAIL_WINDOW) : events;
		// 先收满整个事件尾窗，再取末尾 contextMaxMessages 条。
		// 不能按「凑够 N 条就停」来收：事件按正序投影时，提前收手拿到的是尾窗里
		// 最靠前的 N 条（旧消息），最新几轮对话反而被丢掉。尾窗已限制在
		// EVENT_TAIL_WINDOW 个事件内，整窗投影成本可控。
		const collected = readSurface
			? collectSurfaceDialogTexts(tail, DIALOG_COLLECT_CAP)
			: collectDialogTexts(tail, DIALOG_COLLECT_CAP);
		const texts = collected
			.slice(-cfg.contextMaxMessages)
			.map(({ role, text }) => {
				const clipped = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
				return `[${role === 'user' ? '用户' : '助手'}] ${sanitizeContextText(clipped)}`;
			});
		if (texts.length === 0) return emptyContext(CONTEXT_FIRST_MESSAGE);
		let joined = texts.join('\n');
		if (joined.length > cfg.contextMaxChars) joined = `${joined.slice(0, cfg.contextMaxChars)}…（已截断）`;
		return { text: joined, chars: joined.length };
	} catch (error) {
		// 会话读取失败是 best-effort；但取消/超时必须穿透，否则 handler 会在
		// 上下文读取完成后仍启动模型调用。
		if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'canceled' || error?.code === 'timeout') throw error;
		return emptyContext(CONTEXT_UNAVAILABLE);
	}
}

/** 解析模型路由：设置里同时配置了 provider+model 则用之，否则跟随 DSH 默认模型。 */
function resolveRoute(ctx, cfg) {
	const provider = (cfg.provider ?? '').trim();
	const model = (cfg.model ?? '').trim();
	if (provider !== '' && model !== '') return { provider, model };
	if (provider !== '' || model !== '') {
		throw new Error('提供方与模型 ID 必须同时配置，或都留空以跟随 DSH 默认模型');
	}
	const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
	if (selection === undefined || !selection.provider || !selection.model) {
		throw new Error('没有可用的模型路由：请在设置页配置提供方与模型，或先在 DSH 设置默认模型');
	}
	const route = { provider: selection.provider, model: selection.model };
	if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== null) {
		route.reasoningEffort = selection.reasoningEffort;
	}
	return route;
}

/** 输出清尾：剥掉整段 ``` 围栏（部分模型会给纯文本提示词套围栏）。 */
function stripCodeFence(text) {
	const m = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
	return m === null ? text : m[1];
}

/**
 * 适配层是否因「不支持该推理强度」而拒绝：各 provider 支持的档位并不相同
 * （例如 DeepSeek 只接受 off/low/high/max，没有 medium），插件的设置项是通用
 * 白名单，无法预先知道当前模型支持哪些档位。
 */
function isUnsupportedEffortFailure(failure) {
	if (failure === null || failure === undefined) return false;
	if (failure.code === 'UNSUPPORTED_REASONING_EFFORT') return true;
	const message = typeof failure.message === 'string' ? failure.message : String(failure);
	return /reasoning effort/i.test(message);
}

/** 单次流式调用：聚合文本与结束原因。 */
async function streamOnce(llm, options) {
	let out = '';
	let finish = null;
	for await (const chunk of llm.stream(options)) {
		if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
		else if (chunk?.type === 'finish') finish = chunk.reason;
	}
	return { out, finish };
}

/** 跑一次优化：组装消息 → 流式调用 → 聚合文本。 */
async function runOptimize(ctx, cfg, template, text, contextText, signal) {
	if (signal?.aborted) throw abortReason(signal);
	const route = resolveRoute(ctx, cfg);
	const { system, user } = buildLlmRequest(template, text, contextText);
	const message = {
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text: user }],
		source: { kind: 'plugin', plugin: 'dsh-prompt-optimizer' },
	};
	const options = {
		provider: route.provider,
		model: route.model,
		messages: [message],
		system,
		temperature: cfg.temperature,
		maxTokens: cfg.maxTokens,
		signal,
	};
	if (route.reasoningEffort !== undefined) options.reasoningEffort = route.reasoningEffort;
	// 推理强度设置：inherit=跟随模型默认；显式档位覆盖。设置项是通用白名单，
	// 而各家模型支持的档位不同，被拒绝时下面会丢掉覆盖、按模型默认档位重试一次。
	let overrodeEffort = false;
	if (cfg.reasoningEffort !== 'inherit' && REASONING_EFFORTS.has(cfg.reasoningEffort)) {
		overrodeEffort = options.reasoningEffort !== cfg.reasoningEffort;
		options.reasoningEffort = cfg.reasoningEffort;
	}
	const llm = ctx.get('llm');
	/** 丢弃插件覆盖，回到路由自带（或不带）推理强度。 */
	const withoutEffortOverride = () => {
		const fallback = { ...options };
		if (route.reasoningEffort === undefined) delete fallback.reasoningEffort;
		else fallback.reasoningEffort = route.reasoningEffort;
		return fallback;
	};
	// 只回退一次：第二次仍失败就按普通失败上报，不要来回打模型。
	let retried = false;
	const retryable = (failure) => overrodeEffort && !retried && !signal?.aborted && isUnsupportedEffortFailure(failure);
	const retryWithoutOverride = async () => {
		retried = true;
		ctx.logger?.warn?.(`dsh-prompt-optimizer: 模型不支持推理强度「${cfg.reasoningEffort}」，本次按模型默认档位重试`);
		return streamOnce(llm, withoutEffortOverride());
	};
	let out = '';
	let finish = null;
	try {
		({ out, finish } = await streamOnce(llm, options));
	} catch (error) {
		// 适配层可能直接抛（而不是产出 finish 块）。
		if (!retryable(error)) throw error;
		({ out, finish } = await retryWithoutOverride());
	}
	if (finish?.kind === 'error' && retryable(finish.failure)) {
		({ out, finish } = await retryWithoutOverride());
	}
	// 推理型模型把思考 token 记进同一份输出预算：预算被思考吃光时一个字都吐不出来，
	// 用户看到的是"输出达到 token 上限"而不是结果。这种「纯烧预算」失败按更宽预算
	// 重试一次；已经吐出正文的真截断仍照旧报错，由用户决定调多大。
	if (finish?.kind === 'max-tokens' && out.trim() === '' && !signal?.aborted && cfg.maxTokens < BUDGET_RETRY_CEILING) {
		const widened = Math.min(BUDGET_RETRY_CEILING, cfg.maxTokens * 4);
		ctx.logger?.warn?.(`dsh-prompt-optimizer: 输出预算 ${cfg.maxTokens} 被思考 token 吃光，按 ${widened} 重试一次`);
		({ out, finish } = await streamOnce(llm, { ...options, maxTokens: widened }));
	}
	// 中止归因：request deadline 组合「客户端断开 + 超时」，超时的 reason
	// 是 TimeoutError；按 reason 区分，超时不能报成"已取消"。
	if (signal?.aborted) {
		if (signal.reason?.name === 'TimeoutError') throw Object.assign(new Error('优化超时'), { code: 'timeout' });
		throw Object.assign(new Error('已取消'), { code: 'canceled' });
	}
	const kind = finish?.kind;
	if (kind === 'aborted') {
		if (signal?.aborted && signal.reason?.name === 'TimeoutError') throw Object.assign(new Error('优化超时'), { code: 'timeout' });
		throw Object.assign(new Error('已取消'), { code: 'canceled' });
	}
	if (kind === 'error') throw new Error(`模型调用失败：${finish.failure?.message ?? 'unknown'}`);
	if (kind === 'max-tokens') throw new Error(`输出达到 token 上限（${cfg.maxTokens}）；推理型模型的思考 token 也算在这个预算里，可在设置页调大「单次输出 token 上限」或调低推理强度`);
	if (out.trim() === '') throw new Error('模型没有返回文本');
	return stripCodeFence(out.trim());
}

function apply(ctx) {
	// 设置命名空间（可选）：等 settings 服务就绪后再注册（照 dsh-context 的
	// ctx.inject(['settings'], …) 模式——apply 时刻该服务可能尚未初始化）。
	// 注册失败不影响主功能。命名空间是 branded string，运行时传普通字符串即可。
	let scope = null;
	ctx.inject(['settings'], (sctx) => {
		try {
			const settings = sctx.settings;
			if (settings && typeof settings.register === 'function') {
				scope = settings.register('dsh-prompt-optimizer', Config, {});
			}
		} catch (error) {
			ctx.logger?.warn?.('dsh-prompt-optimizer: settings 注册失败，使用默认配置', error);
		}
	});
	const config = () => {
		try {
			const value = scope?.get();
			return value !== undefined && value !== null && typeof value === 'object' ? value : {};
		} catch {
			return {};
		}
	};

	ctx.webServer.register({
		kind: 'exact',
		path: '/api/dsh-prompt-optimizer/templates',
		handler: async (req, res) => {
			if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' });
			if (req.method !== 'GET' && req.method !== undefined) return writeJson(res, 405, { ok: false, error: 'GET only' }, { allow: 'GET' });
			writeJson(res, 200, {
				ok: true,
				templates: TEMPLATES.map(({ id, name: templateName, desc, category }) => ({ id, name: templateName, desc, category })),
			});
		},
	});

	ctx.webServer.register({
		kind: 'exact',
		path: '/api/dsh-prompt-optimizer/optimize',
		handler: async (req, res) => {
			if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' });
			if (req.method !== 'POST' && req.method !== undefined) return writeJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' });

			// 从读取请求体开始监听响应断开，避免客户端在 body 解析期间取消时漏掉事件。
			// res 的 close 同时覆盖正常结束和提前断开；writableEnded 用来区分二者。
			const controller = new AbortController();
			const onResponseClose = () => {
				if (!res.writableEnded) controller.abort(abortError('客户端已断开'));
			};
			if (typeof res.on === 'function') res.on('close', onResponseClose);
			const detachResponseClose = () => {
				if (typeof res.off === 'function') res.off('close', onResponseClose);
				else if (typeof res.removeListener === 'function') res.removeListener('close', onResponseClose);
			};

			let body;
			try {
				body = await readBody(req, 256 * 1024, controller.signal);
			} catch (error) {
				detachResponseClose();
				if (controller.signal.aborted || error?.name === 'AbortError') return;
				const status = error?.code === 'body-too-large' ? 413 : 400;
				return writeJson(res, status, { ok: false, error: `bad body: ${boundedError(error)}` });
			}
			const templateId = typeof body?.templateId === 'string' ? body.templateId : '';
			const text = typeof body?.text === 'string' ? body.text : '';
			const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
			if (templateId.length > MAX_TEMPLATE_ID_CHARS) {
				detachResponseClose();
				return writeJson(res, 400, { ok: false, error: '模板 ID 过长' });
			}
			const template = TEMPLATE_MAP.get(templateId);
			if (template === undefined) {
				detachResponseClose();
				return writeJson(res, 400, { ok: false, error: `未知模板：${templateId}` });
			}
			if (text.trim() === '') {
				detachResponseClose();
				return writeJson(res, 400, { ok: false, error: '输入框为空，先写点内容再优化' });
			}

			const raw = config();
			const cfg = {
				provider: typeof raw.provider === 'string' ? raw.provider : '',
				model: typeof raw.model === 'string' ? raw.model : '',
				temperature: typeof raw.temperature === 'number' && raw.temperature >= 0 && raw.temperature <= 2 ? raw.temperature : 0.3,
				reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort : 'inherit',
				maxTokens: positiveIntOr(raw.maxTokens, DEFAULT_MAX_TOKENS),
				timeoutMs: timeoutOr(raw.timeoutMs, 120000),
				maxInputChars: positiveIntOr(raw.maxInputChars, MAX_INPUT_CHARS_FALLBACK),
				contextMaxMessages: Math.min(DIALOG_COLLECT_CAP, nonNegativeIntOr(raw.contextMaxMessages, 12)),
				contextMaxChars: nonNegativeIntOr(raw.contextMaxChars, 4000),
			};
			const maxChars = cfg.maxInputChars > 0 ? cfg.maxInputChars : MAX_INPUT_CHARS_FALLBACK;
			if (text.length > maxChars) {
				detachResponseClose();
				return writeJson(res, 400, { ok: false, error: `文本过长（${text.length} > ${maxChars} 字符），可截取后重试或在设置页调大上限` });
			}
			if (controller.signal.aborted) {
				detachResponseClose();
				return;
			}

			const startedAt = Date.now();
			const deadline = createDeadline(controller.signal, cfg.timeoutMs);
			try {
				// 同一个 deadline 覆盖上下文读取和模型调用；否则慢的 sessionQuery 会
				// 绕过“单次优化超时”，并在用户取消后继续阻塞 handler。
				const context = template.category === 'context'
					? await gatherContext(ctx, sessionId, cfg, deadline.signal)
					: { text: '', chars: 0 };
				// LLM adapters normally honor options.signal; the outer race also bounds
				// handler latency when an older adapter does not.
				const optimized = await withAbort(
					runOptimize(ctx, cfg, template, text, context.text, deadline.signal),
					deadline.signal,
				);
				writeJson(res, 200, {
					ok: true,
					text: optimized,
					ms: Date.now() - startedAt,
					// 只统计真实对话字符：占位标记不计入，客户端据此提示本次没带上下文。
					contextChars: context.chars,
				});
			} catch (error) {
				// 超时与用户取消分开报：超时给可操作的提示，取消才静默。
				if (error?.code === 'timeout' || error?.name === 'TimeoutError' || deadline.signal.reason?.name === 'TimeoutError') {
					// 秒数向上取整并至少显示 1 秒：Math.round 会把 <500ms 的超时说成
					// 「0 秒」，用户看不懂也没法据此调参。
					const seconds = Math.max(1, Math.ceil(cfg.timeoutMs / 1000));
					return writeJson(res, 200, { ok: false, error: 'timeout', message: `优化超时（${seconds} 秒），可在「设置 → 提示词优化」调大超时或调低推理强度` });
				}
				if (controller.signal.aborted || error?.code === 'canceled' || error?.name === 'AbortError') {
					return writeJson(res, 200, { ok: false, error: 'canceled' });
				}
				ctx.logger?.warn?.('dsh-prompt-optimizer: 优化失败', error);
				writeJson(res, 200, { ok: false, error: boundedError(error) });
			} finally {
				deadline.dispose();
				detachResponseClose();
			}
		},
	});
}

export { apply };
