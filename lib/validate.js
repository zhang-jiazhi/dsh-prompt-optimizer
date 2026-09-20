/**
 * 输出守卫：模板自检之外的第二道确定性防线。
 *
 * 设计取舍：这里只做「检测 + 轻量规范化」，默认不自动重试。重试会让一次
 * 优化的延迟与成本翻倍，而模板本身已经写了大量自检规则；先把问题变成
 * 用户可见的告警，再根据真实数据决定哪些告警值得升级成重试。
 *
 * 覆盖分层：
 *   - 保真类检查（占位符 / JSON 结构 / 显式数字）对所有模板生效：图像类与
 *     角色卡类模板同样逐字承诺了这些保真协议，此前完全没有兜底；
 *   - 任务指令语义检查（角色卡泄漏 / 体量 / 身份句）只对任务指令类生效：
 *     角色卡模板本来就该输出 # Role，图像类也不套用任务指令的体量规则；
 *   - 指代兜底与虚构授权检查对所有模板生效（纯痕迹检测，不依赖任务指令语义）。
 *
 * TASK_LIKE_TEMPLATE_IDS 是硬编码集合：新增模板时如果忘了分类，守卫会静默
 * 不生效。host-smoke 里有一条断言强制"每个模板要么在任务指令集合里、要么在
 * 显式豁免清单里"，忘记分类会让测试失败而不是静默漏掉。
 */

/** 待优化草稿里的变量占位符（{{name}}），用于校验输出是否逐字保留。 */
const PLACEHOLDER_PATTERN = /\{\{[^{}\n]{1,80}\}\}/g;

/** 只对这 6 个模板做任务指令语义的守卫。 */
export const TASK_LIKE_TEMPLATE_IDS = new Set([
	'user-task-optimize',
	'user-task-planning',
	'secure-reverse-optimize',
	'context-message-optimize',
	'context-analytical-optimize',
	'context-output-format-optimize',
]);

/** 角色卡结构：任务指令模板里出现即为跑偏。#{1,6}：四级以下的深层标题（#### Skills…）同样是角色卡（二轮 P3）。 */
const ROLE_CARD_PATTERN = /^\s*#{1,6}\s*(?:Role|Profile|Skills|Initialization)\b/im;

/** 模型偶尔加在正文开头的引导词。 */
const LEADING_PREFIX_PATTERN = /^(?:以下(?:是|为)?\s*)?(?:优化后(?:的提示词|的版本)?|优化结果|改写后(?:的提示词)?|优化后的版本|Optimized(?:\s+prompt)?)\s*[:：]\s*/i;

/**
 * 短草稿的输出体量上限。对齐 intent-rules 铁律 9 的承诺（30 字以内的一句话
 * 草稿不超过 12 行 / 400 字）：旧阈值 max(1200, draft*8) 比承诺宽三倍，
 * 实测「检查提示词」（5 字）输出 800 字也不告警。
 */
const VERBOSE_MIN_DRAFT_CHARS = 200;
const VERBOSE_HARD_LIMIT = 400;
const VERBOSE_RATIO = 6;

/**
 * 草稿开头的身份句：任务指令类必须原样保留在开场。
 * 中英双写——铁律 2 对任何语言都适用，只认中文会让英文草稿的身份句裸奔。
 */
const IDENTITY_LEAD_PATTERN = /^你是[^\n。，]{1,40}?(?:专家|工程师|顾问|审计员|研究员|设计师|架构师|分析师|程序员|律师|医生)|^You are (?:a|an|the) [^\n.]{1,60}?(?:expert|engineer|specialist|consultant|analyst|developer|architect|researcher|auditor|scientist|professional)/i;

/** 草稿里的显式量化约束（「100 行」「3 条」）：输出必须保留那个数字。 */
const EXPLICIT_NUMBER_PATTERN = /(\d+(?:\.\d+)?)\s*(?:行|个|条|次|秒|毫秒|倍|处|张|份|字)/g;

/**
 * 用户明写约束的账本：0.6.1 的 P0 是"模型把用户明写的约束整条删掉"，但当时的
 * 修复只在 prompt 层（intent-rules 铁律 4 / task-strength 第一节）。代码层此前能
 * 确定性检查的只有占位符、JSON 键路径和"带中文量词的数字"（EXPLICIT_NUMBER_PATTERN），
 * 「只改这一处 / 不要重构 / 先问我再动手 / 最小改动」这类没有量词的约束被删掉时
 * warnings 仍是 []。
 *
 * 判据刻意保守：先按标点切成短句，只留命中"约束信号"的短句（信号词与
 * intent-rules 铁律 4 列出的清单对齐），再把短句切成实词集合比对覆盖率。
 *   - 数字这类 ASCII 实词最硬、最不容易被同义改写，必须还在；
 *   - 纯中文约束按 2-gram 覆盖率判定（换语序/换近义词仍能命中大部分 gram）；
 *   - 含数字的约束若数字还在，就交给已有的 explicit-number-missing，不重复报；
 *   - 任务指令类用 34% 阈值（允许同义改写，整条删除必然命中）；其余模板只在
 *     "一个实词都找不到"（完全删除）时告警，避免图像/角色卡类被同义改写误报。
 */
const CONSTRAINT_FAMILIES = [
	{ name: '禁止类', pattern: /(?:不要|不许|不准|不得|禁止|别再|别动|别改|别用|先别)/ },
	{ name: '范围类', pattern: /(?:只改|只写|只动|只保留|只允许|只处理|只做|仅改|仅限)/ },
	{ name: '流程类', pattern: /(?:先问我|先确认|先复现|先[^，,。；;\n]{0,8}(?:再|然后)|做完[^，,。；;\n]{0,8}(?:告诉|报|说明))/ },
	{ name: '数量类', pattern: /(?:限制在?|不超过|最多|至少|上限)[^，,。；;\n]{0,12}\d/ },
	{ name: '强制类', pattern: /(?:必须|务必|一定要)/ },
	{ name: '规模类', pattern: /(?:最小改动|最小化改动|保持原样|保持不变)/ },
	{ name: '禁止类(EN)', pattern: /\b(?:do not|don't|never|must not|avoid)\b/i },
	{ name: '范围类(EN)', pattern: /\b(?:only|just)\b/i },
	{ name: '强制类(EN)', pattern: /\b(?:must|always|make sure)\b/i },
	{ name: '数量类(EN)', pattern: /\b(?:within|at most|no more than|at least|limit(?:ed)? to)\b/i },
];

/** 约束短句切分：中英标点都切，英文句末点只在后跟空白时切（别切坏 auth.js）。 */
const CONSTRAINT_CLAUSE_SPLIT = /[，,。！？!?；;\n]+|(?<=[.!?])\s+/;

/** 2-gram 生成前先滤掉的高频虚词。刻意保留「不 / 没 / 别 / 要」——「不要 / 别」是否定核心，「要」是「不要」的一半。 */
const CONSTRAINT_STOPWORD_CHARS = new Set('这那的了是很就都也还我你他她它个把被给让和与及或但而如果那么之其此该等只');
const CONSTRAINT_STOPWORDS_EN = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be', 'it', 'this', 'that', 'my', 'your', 'me', 'you', 'i', 'do', 'not', 'no']);

/** 任务指令类模板的覆盖率阈值；其余模板只用 0（完全删除）判定。 */
const CONSTRAINT_COVERAGE_MIN = 0.33;

/** 把约束短句切成实词集合：ASCII 词/数字 + 中文 2-gram。 */
function constraintTokens(clause) {
	const tokens = new Set();
	for (const token of clause.match(/[A-Za-z][A-Za-z0-9_.:'/-]*|\d+(?:\.\d+)?/g) ?? []) {
		const lower = token.toLowerCase();
		if (/^\d/.test(lower) || !CONSTRAINT_STOPWORDS_EN.has(lower)) tokens.add(lower);
	}
	const cjk = [...clause.replace(/[^\u4e00-\u9fff]/g, '')].filter((char) => !CONSTRAINT_STOPWORD_CHARS.has(char)).join('');
	for (let index = 0; index + 1 < cjk.length; index += 1) tokens.add(cjk.slice(index, index + 2));
	return tokens;
}

/** 抽取草稿里命中约束信号的短句（去重、保持出现顺序）。 */
function extractConstraintClauses(draft) {
	const found = [];
	const seen = new Set();
	for (const raw of String(draft ?? '').split(CONSTRAINT_CLAUSE_SPLIT)) {
		const clause = raw.trim();
		if (clause.length < 2 || clause.length > 60 || seen.has(clause)) continue;
		const family = CONSTRAINT_FAMILIES.find((item) => item.pattern.test(clause));
		if (family === undefined) continue;
		seen.add(clause);
		found.push({ clause, family: family.name });
	}
	return found;
}

/**
 * 方法侧镣铐词表：用户没写、但模型爱自己加上的「限制助手怎么干活」的约束。
 * 与 intent-rules 铁律 4 / task-strength 第一节列出的清单对齐——prompt 层一直在
 * 骂这件事（「戴镣铐」「编造约束」），但代码层此前零防守：输出凭空多写
 * 「最小改动 / 不要重构 / 只改一处 / 先问我 / 必须补测试」不会触发任何告警。
 *
 * 判据同样保守：只认这些高频固定说法（含英文常见写法），并且要求**草稿里没有
 * 同源说法**；用户自己写过的（哪怕措辞不同）一律不报。
 */
const INVENTED_HANDCUFF_PATTERNS = [
	/最小化?改动/, /不要重构/, /不(?:要|得|许)重构/, /只改(?:这|该|此)?一?处/, /只动(?:这|该|此)?一?处/,
	/不改(?:动)?(?:其他|其它|别的)(?:代码|文件|部分)?/, /先(?:问|跟)我(?:确认)?再(?:动手|做|改)/,
	/先(?:向)?我确认/, /必须补(?:上)?(?:回归)?测试/, /不(?:要|得|许|准)加(?:新)?依赖/,
	/禁止(?:新增|添加)(?:任何)?依赖/, /限制在\s*\d+\s*行/,
	/\bminimal change/i, /\bdo not refactor\b/i, /\bdon't refactor\b/i, /\bonly change (?:this|one)\b/i,
	/\bask (?:me )?before\b/i, /\bmust add tests?\b/i, /\bno new dependencies?\b/i,
];

/** 草稿里是否已经出现同源说法（用户自己写的），出现过就不算「凭空新增」。 */
function draftMentionsHandcuff(draft) {
	return INVENTED_HANDCUFF_PATTERNS.some((pattern) => pattern.test(draft));
}

/** 输出里凭空新增的方法侧镣铐（草稿没有同源说法时才算）。 */
function findInventedHandcuffs(draft, output) {
	if (draftMentionsHandcuff(draft)) return [];
	const text = String(output ?? '');
	const hits = [];
	for (const pattern of INVENTED_HANDCUFF_PATTERNS) {
		const match = pattern.exec(text);
		if (match === null) continue;
		const snippet = match[0];
		if (!hits.includes(snippet)) hits.push(snippet);
	}
	return hits;
}

/**
 * 约束账本：草稿里明写的约束在输出里找不到实词时告警（删除侧），
 * 以及输出里凭空出现草稿没有的方法侧镣铐时告警（新增侧）。
 * 返回结构化统计，客户端据此显示「约束 保留 N · 删除 X · 新增 Y」。
 * @returns {{ warnings: Array<{code: string, message: string}>, stats: {kept: number, dropped: number, invented: number} }}
 */
export function constraintLedger(draft, output, { taskLike = false } = {}) {
	const constraints = extractConstraintClauses(draft);
	const haystack = String(output ?? '').toLowerCase();
	const missing = [];
	for (const { clause } of constraints) {
		const numbers = clause.match(/\d+(?:\.\d+)?/g) ?? [];
		// 数字还在就认为这条量化约束保住了：单位词的同义改写不算丢约束，
		// 重复报只会制造噪音（explicit-number-missing 已经兜住数字丢失）。
		if (numbers.length > 0 && numbers.every((number) => haystack.includes(number))) continue;
		const tokens = [...constraintTokens(clause)];
		if (tokens.length === 0) continue;
		const hit = tokens.filter((token) => haystack.includes(token)).length;
		const coverage = hit / tokens.length;
		// 任务指令类允许同义改写（覆盖率阈值）；其余模板只在完全找不到实词时告警，
		// 避免图像/角色卡类被正常润色误报。
		const lost = taskLike ? coverage < CONSTRAINT_COVERAGE_MIN : coverage === 0;
		if (lost) missing.push(clause);
	}
	const warnings = [];
	if (missing.length > 0) {
		const shown = missing.slice(0, 2).map((clause) => `「${clause.slice(0, 14)}${clause.length > 14 ? '…' : ''}」`).join('、');
		warnings.push({
			code: 'constraint-missing',
			message: `用户明写的约束可能被删除或改义：${shown}${missing.length > 2 ? `（共 ${missing.length} 条）` : ''}`,
		});
	}
	const invented = findInventedHandcuffs(draft, output);
	if (invented.length > 0) {
		warnings.push({
			code: 'constraint-invented',
			message: `输出新增了草稿没写的工作方式限制：${invented.slice(0, 3).join('、')}${invented.length > 3 ? `（共 ${invented.length} 处）` : ''}`,
		});
	}
	return {
		warnings,
		stats: { kept: constraints.length - missing.length, dropped: missing.length, invented: invented.length },
	};
}

/**
 * 兼容旧调用：只要删除侧的告警对象。
 * @returns {{ code: string, message: string } | null}
 */
export function constraintLedgerWarning(draft, output, options) {
	return constraintLedger(draft, output, options).warnings.find((warning) => warning.code === 'constraint-missing') ?? null;
}

/**
 * 强信号：模型把"未解析的指代"当成一个内容对象在使用时才写这些措辞。
 * 注意不能把引号模式放进来——「已知：草稿只写了「修复它」」是对草稿原文的
 * 合法引用（原文保真要求），引号模式只允许在「目标」节里判（见下）。
 */
const DANGLING_REFERENCE_PATTERN = /指代的对象|指代的问题|指代的内容|指代见待确认|以对话上下文为准|之前提到|之前说的|前面提到|提到的那个/;

/** 目标节里的引号指代：缺陷形态是「目标」把「「它」指代的问题」当成对象。 */
const GOAL_DANGLING_PATTERN = /「[^」]{0,15}(?:它|那个|这个)[^」]{0,15}」/;

/**
 * 骨架小节标记。模型写小节名的方式并不统一：`目标：` / `## 目标：` /
 * `**目标**：` / `**待确认**（可先按合理默认推进）：` 都要认，否则定位不到
 * 目标节与待确认边界——前者让引号判据整条失效，后者会把待确认区当成正文。
 */
const GOAL_MARK = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?目标(?:\*\*|__)?[ \t]*[：:][ \t]*/m;

/** 「已知 / 待确认」小节标题行：这两节的指代是合法的（见 bodyOutsideReferenceSections）。 */
const KNOWN_OR_PENDING_MARK = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?(?:已知|待确认)(?:\*\*|__)?[ \t]*(?=[：:（(]|$)/;
/** 其他骨架小节标题（目标：/ 完成标准：…）：结束小节跳过；列表行（- x）与正文冒号句不算标题。 */
const OTHER_SECTION_MARK = /^[ \t]*(?![-*•\d])[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[^\n：:]{1,12}(?:\*\*|__)?[ \t]*[：:]/;
const SECTION_BOUNDARY = /(?:^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?(?:已知|范围|约束|完成标准|交付)(?:\*\*|__)?[ \t]*(?=[：:（(]|$))|(?:^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?待确认(?:\*\*|__)?)|(?:\n[ \t]*\n)/m;

/** 取「目标」节正文（到空行或下一个骨架小节为止）；定位不到「目标：」时返回空串。 */
function goalSection(text) {
	const start = GOAL_MARK.exec(text);
	if (start === null) return '';
	const rest = text.slice(start.index + start[0].length);
	const stop = SECTION_BOUNDARY.exec(rest);
	return stop === null ? rest : rest.slice(0, stop.index);
}

/**
 * 指代兜底的检查范围：跳过「已知 / 待确认」小节内的行（粗粒度：按节标题行 +
 * 空行切分）。这两处的指代是合法的——「已知」在复述草稿语境，长草稿的
 * 「之前提到的报错」是合法回指，逐行全查必然误报（二轮 P3）；「待确认」本来就
 * 是提问区。切不准时宁可漏报：把合法回指误报成缺陷比偶尔漏报更伤。
 */
function bodyOutsideReferenceSections(text) {
	const kept = [];
	let skipping = false;
	for (const line of String(text ?? '').split('\n')) {
		if (KNOWN_OR_PENDING_MARK.test(line)) {
			skipping = true;
			continue;
		}
		if (skipping && (line.trim() === '' || OTHER_SECTION_MARK.test(line))) skipping = false;
		if (!skipping) kept.push(line);
	}
	return kept.join('\n');
}

/**
 * 草稿里的授权信号：用户自己声明了归属、授权或测试环境。
 * 命中任一即认为"用户已给出合法上下文"，输出据此声明授权是允许的。
 */
const AUTHORIZATION_SIGNAL_PATTERN = /我自己的|我自己(?:写|做|开发|搭建)的|我开发的|我司|我们公司|书面授权|已获授权|已授权|授权范围|CTF|靶场|靶机|测试环境|渗透测试|安全审计|红队|蓝队|防御研究/;

/**
 * 虚构授权：输出替用户声明了**无条件**的授权或所有权。
 * 刻意不匹配「我拥有或已获授权的目标软件」这类条件式表述——secure-tail 的
 * 正例就是这么写的（授权本身仍留在「待确认」里），它不算虚构。
 */
const FABRICATED_AUTHORIZATION_PATTERN = /(?:我|本人)(?:已经?|已)(?:获得|取得|拿到|拥有)(?:了)?(?:书面)?的?授权|(?:我|本人)(?:拥有|持有)(?:该|此|目标)?(?:软件|系统|程序|网站|设备)的?(?:合法|书面)授权/;

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
 * 收集对象里的全部键路径（递归）。数组元素沿用父前缀，不把下标写进路径——
 * 否则模型重排数组会被误判成字段丢失。
 */
export function collectKeyPaths(value, prefix = '', out = new Set()) {
	if (value === null || typeof value !== 'object') return out;
	if (Array.isArray(value)) {
		for (const item of value) collectKeyPaths(item, prefix, out);
		return out;
	}
	for (const [key, child] of Object.entries(value)) {
		const path = prefix === '' ? key : `${prefix}.${key}`;
		out.add(path);
		collectKeyPaths(child, path, out);
	}
	return out;
}

/**
 * JSON 结构保真：草稿本身是结构化对象时，输出必须仍是合法 JSON 且不丢字段。
 * 图像类模板承诺「保持原有字段名、字段层级、数组顺序」（JSON 模式）。
 * 只报"丢失"，不报"新增"——新增字段虽然也不该有，但丢失确定是坏事，
 * 单向判定可以避免模型补全字段时被误报。
 */
export function jsonStructureWarning(draft, output) {
	const source = String(draft ?? '').trim();
	if (!source.startsWith('{') && !source.startsWith('[')) return null;
	let draftObject;
	try {
		draftObject = JSON.parse(source);
	} catch {
		return null; // 草稿本身不是合法 JSON（例如只是长得像），不检查
	}
	let outputObject;
	try {
		outputObject = JSON.parse(String(output ?? '').trim());
	} catch {
		return { code: 'json-broken', message: '草稿是 JSON，但输出已不是合法 JSON（结构化字段可能被破坏）' };
	}
	const outputPaths = collectKeyPaths(outputObject);
	const lost = [...collectKeyPaths(draftObject)].filter((path) => !outputPaths.has(path));
	if (lost.length > 0) {
		return {
			code: 'json-keys-changed',
			message: `JSON 字段丢失：${lost.slice(0, 3).join('、')}${lost.length > 3 ? '…' : ''}`,
		};
	}
	return null;
}

/**
 * 校验并轻量规范化一次优化结果。
 * @param {{ template: { id: string }, draft: string, output: string }} input
 * @returns {{ text: string, warnings: Array<{ code: string, message: string }>, ledger: { kept: number, dropped: number, invented: number } }}
 */
export function validateOptimizedOutput({ template, draft, output }) {
	let text = String(output ?? '');
	const draftText = String(draft ?? '');
	const warnings = [];

	const stripped = stripLeadingPrefix(text);
	if (stripped !== text) {
		text = stripped;
		warnings.push({ code: 'prefix-stripped', message: '已自动去掉“优化后：”之类的前缀' });
	}

	// —— 保真类检查：对所有模板生效 ——

	const missing = extractPlaceholders(draftText).filter((placeholder) => !text.includes(placeholder));
	if (missing.length > 0) {
		const shown = missing.slice(0, 3).join('、');
		warnings.push({
			code: 'placeholder-missing',
			message: `有 ${missing.length} 个变量占位符未保留：${shown}${missing.length > 3 ? '…' : ''}`,
		});
	}

	const jsonWarning = jsonStructureWarning(draftText, text);
	if (jsonWarning !== null) warnings.push(jsonWarning);

	const numbers = [...new Set([...draftText.matchAll(EXPLICIT_NUMBER_PATTERN)].map((match) => match[1]))];
	const lostNumbers = numbers.filter((number) => !text.includes(number));
	if (lostNumbers.length > 0) {
		warnings.push({
			code: 'explicit-number-missing',
			message: `草稿里的量化约束未保留：${lostNumbers.slice(0, 3).join('、')}`,
		});
	}

	// —— 约束账本：对所有模板生效。0.6.1 的 P0（删用户明写的约束）此前只有
	// prompt 层兜底，代码层删掉「不要重构 / 只改这一处 / 先问我再动手」不会告警；
	// 0.7.1 起同时检查新增侧（凭空戴镣铐），并把统计透给客户端做变更摘要。 ——

	const ledger = constraintLedger(draftText, text, { taskLike: isTaskLikeTemplate(template) });
	warnings.push(...ledger.warnings);
	const ledgerStats = ledger.stats;

	// —— 任务指令语义检查：只对 6 个任务指令类模板生效 ——

	if (isTaskLikeTemplate(template)) {
		// 空白归一后再比对（二轮 P3）：模型常只改排版（全角空格 / 换行缩进），
		// 逐字 startsWith 会把「内容保住了、只是空白不同」误报成 identity-dropped。
		const withoutWhitespace = (value) => value.replace(/\s+/g, '');
		const identityMatch = IDENTITY_LEAD_PATTERN.exec(draftText.trim());
		if (identityMatch !== null && !withoutWhitespace(text).startsWith(withoutWhitespace(identityMatch[0]))) {
			warnings.push({
				code: 'identity-dropped',
				message: '草稿开头的身份句没有原样出现在开场（子代理场景下提示词正文是唯一身份通道）',
			});
		}

		if (ROLE_CARD_PATTERN.test(text)) {
			warnings.push({
				code: 'role-card-leak',
				message: '输出疑似角色卡（# Role / ## Profile），与任务指令身份不符',
			});
		}

		const draftLength = draftText.trim().length;
		if (draftLength > 0 && draftLength <= VERBOSE_MIN_DRAFT_CHARS) {
			const limit = Math.min(VERBOSE_HARD_LIMIT * 2, Math.max(VERBOSE_HARD_LIMIT, draftLength * VERBOSE_RATIO));
			if (text.length > limit) {
				warnings.push({
					code: 'verbose',
					message: `输出 ${text.length} 字，约为原文的 ${Math.round(text.length / draftLength)} 倍（短草稿上限约 ${limit} 字），注意是否注水`,
				});
			}
		}
	}

	// —— 指代兜底：对所有模板生效。只告警、不阻断、不自动重试 ——
	// 引号模式只在「目标」节里判：「已知」节引用草稿原文（草稿只写了「修复它」）
	// 是合法的原文保真，不能当成未解析的指代；词句模式也跳过「已知 / 待确认」
	// 小节（长草稿的合法回指，见 bodyOutsideReferenceSections）。

	const body = bodyOutsideReferenceSections(text);
	if (DANGLING_REFERENCE_PATTERN.test(body) || GOAL_DANGLING_PATTERN.test(goalSection(text))) {
		warnings.push({
			code: 'dangling-reference',
			message: '正文里还留着未解析的指代（「它」/「那个问题」/「之前提到的」），应只出现在「待确认」',
		});
	}

	// —— 虚构授权：只对逆向模板生效 ——
	// secure-tail 最重的承诺是"绝不替草稿虚构授权"（带正例与反例），但此前
	// 只有 prompt 层、代码层零兜底：草稿「帮我破解这个软件的注册码」没有授权
	// 信号，输出却写「对**我已经获得书面授权的**目标软件…」时不会告警。

	if (template?.id === 'secure-reverse-optimize'
		&& !AUTHORIZATION_SIGNAL_PATTERN.test(draftText)
		&& FABRICATED_AUTHORIZATION_PATTERN.test(text)) {
		warnings.push({
			code: 'fabricated-authorization',
			message: '草稿没有任何授权信号，输出却替用户声明了授权（本模板明令禁止虚构授权）',
		});
	}

	return { text, warnings, ledger: ledgerStats };
}
