// @local/dsh-prompt-optimizer — browser client half (harness ModuleLoader format,
// hand-written, no bundler). Declared via package.json `dsh.client`.
//
// UI（输入框工具行，权限选择器右侧 = conversation.input.left 插槽）：
//   [类别 ▾] [模板 ▾(富下拉：名称+描述)] [✨优化按钮]
//   - 类别：基础 / 上下文 / 图像（模板目录来自宿主 /api/dsh-prompt-optimizer/templates）
//   - 优化按钮三态：✨ 优化 → 转圈（再点取消，客户端断开即中止模型调用）→ ↺ 撤销
//     （草稿未被手动编辑时可一键恢复原文）；错误红闪 4 秒提示。
//   - 类别与模板选择记入 localStorage，下次打开保持。
window.__ModuleLoader__.load({
	id: '@local/dsh-prompt-optimizer',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		var React = require('react');

		/** Only slots is required; settingsScope is an optional nested dependency. */
		var inject = ['slots'];

		var TEMPLATES_URL = '/api/dsh-prompt-optimizer/templates';
		var OPTIMIZE_URL = '/api/dsh-prompt-optimizer/optimize';
		var STYLE_ID = 'dpo-style';
		var STORE_KEY = 'dsh-prompt-optimizer:selection:v1';
		/** 页面级模板目录缓存（宿主启动后模板固定；见挂载 effect）。 */
		var catalogCache = null;

		var CATEGORY_ORDER = ['basic', 'context', 'image'];
		var CATEGORY_NAMES = { basic: '基础', context: '上下文', image: '图像' };

		var styles = [
			'.dpo-bar{display:inline-flex;align-items:center;gap:2px;min-width:0}',
			'.dpo-cat{height:26px;padding:0 4px 0 6px;font-size:12px;color:var(--dsw-alias-text-primary,inherit);background:transparent;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.35));border-radius:6px;cursor:pointer;max-width:76px}',
			'.dpo-cat:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a9eff);outline-offset:1px}',
			'.dpo-tpl{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 6px;max-width:150px;font-size:12px;color:var(--dsw-alias-text-primary,inherit);background:transparent;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.35));border-radius:6px;cursor:pointer;white-space:nowrap}',
			'.dpo-tpl:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.12))}',
			'.dpo-tpl:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a9eff);outline-offset:1px}',
			'.dpo-tpl:disabled{opacity:.4;cursor:not-allowed}',
			'.dpo-tpl-label{overflow:hidden;text-overflow:ellipsis}',
			'.dpo-caret{flex:none;font-size:9px;opacity:.6;transform:scaleY(.8)}',
			'.dpo-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;transition:background-color .15s ease,color .15s ease,opacity .15s ease}',
			'.dpo-btn:hover:not(:disabled),.dpo-btn:focus-visible{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.12));color:var(--dsw-alias-brand-primary,inherit)}',
			'.dpo-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a9eff);outline-offset:1px}',
			'.dpo-btn:disabled{opacity:.4;cursor:not-allowed}',
			'.dpo-btn.is-undo{color:var(--dsw-alias-brand-primary,inherit)}',
			'.dpo-btn.has-error{color:var(--dsw-alias-state-error-primary,#d93026)}',
			'.dpo-notice{font-size:11px;line-height:26px;color:var(--dsw-alias-label-secondary,#999);margin-left:2px;white-space:nowrap;cursor:default}',
			'.dpo-tpl-wrap{position:relative;display:inline-flex}',
			'.dpo-panel{position:absolute;bottom:calc(100% + 8px);left:0;z-index:2147483000;width:320px;max-height:340px;overflow:auto;padding:4px;border-radius:10px;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 8px 28px rgba(0,0,0,.18)}',
			'.dpo-item{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:8px;cursor:pointer}',
			'.dpo-item:hover,.dpo-item.is-active{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.12))}',
			'.dpo-item-body{flex:1;min-width:0}',
			'.dpo-item-name{font-size:13px;font-weight:600;color:var(--dsw-alias-text-primary,inherit);line-height:1.4}',
			'.dpo-item-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#999);line-height:1.5;margin-top:2px;word-break:break-word}',
			'.dpo-item-check{flex:none;color:var(--dsw-alias-brand-primary,#4a9eff);font-size:13px;line-height:1.6}',
			'.dpo-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;padding:0;margin:-1px}',
			'@media (max-width:560px){.dpo-panel{width:min(320px,calc(100vw - 16px));max-width:calc(100vw - 16px);box-sizing:border-box}.dpo-set-row{align-items:flex-start;flex-wrap:wrap}.dpo-set-label{width:100%}.dpo-set-input{flex-basis:100%;min-width:0}.dpo-set-hint{margin-left:0}}',
		].join('');

		function ensureStyles() {
			if (document.getElementById(STYLE_ID)) return;
			var style = document.createElement('style');
			style.id = STYLE_ID;
			style.textContent = styles;
			document.head.appendChild(style);
		}

		// ✨ 优化 glyph（Lucide sparkles）。
		function SparklesIcon() {
			return React.createElement('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
				React.createElement('path', { d: 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z' }),
				React.createElement('path', { d: 'M20 3v4' }),
				React.createElement('path', { d: 'M22 5h-4' }),
				React.createElement('path', { d: 'M4 17v2' }),
				React.createElement('path', { d: 'M5 18H3' }));
		}

		// 旋转弧线 spinner（SMIL，无 CSS keyframes）。
		function SpinnerIcon() {
			return React.createElement('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', 'aria-hidden': true },
				React.createElement('circle', { cx: 12, cy: 12, r: 8, stroke: 'var(--dsw-alias-brand-primary,currentColor)', strokeWidth: 2.5, opacity: 0.25 }),
				React.createElement('path', { d: 'M20 12a8 8 0 0 0-8-8', stroke: 'var(--dsw-alias-brand-primary,currentColor)', strokeWidth: 2.5, strokeLinecap: 'round' },
					React.createElement('animateTransform', { attributeName: 'transform', type: 'rotate', from: '0 12 12', to: '360 12 12', dur: '0.8s', repeatCount: 'indefinite' })));
		}

		// ↺ 撤销 glyph：恢复优化前的草稿。
		function UndoIcon() {
			return React.createElement('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
				React.createElement('path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
				React.createElement('path', { d: 'M3 3v5h5' }));
		}

		function loadSelection() {
			try {
				var raw = window.localStorage.getItem(STORE_KEY);
				var value = raw === null ? null : JSON.parse(raw);
				return value !== null && typeof value === 'object' ? value : {};
			} catch { return {}; }
		}

		function saveSelection(selection) {
			try { window.localStorage.setItem(STORE_KEY, JSON.stringify(selection)); } catch { /* 无痕模式等场景忽略 */ }
		}

		function defaultTemplateId(templates, category) {
			var item = templates.find(function (t) { return t.category === category; });
			return item === undefined ? null : item.id;
		}

		function PromptOptimizerBar(props) {
			ensureStyles();
			// 模板目录（挂载时拉取一次；同源 loopback 接口，失败时按钮禁用并提示）。
			var catalogState = React.useState(null);
			var templates = catalogState[0];
			var setTemplates = catalogState[1];
			// 当前类别 + 每类别记住的模板。
			var selState = React.useState(function () {
				var saved = loadSelection();
				return { category: CATEGORY_ORDER.includes(saved.category) ? saved.category : 'basic', byCategory: saved.byCategory && typeof saved.byCategory === 'object' ? saved.byCategory : {} };
			});
			var sel = selState[0];
			var setSel = selState[1];
			// 状态机：null=空闲 'busy'=优化中 {original}=成功可撤销 {error}=错误闪现。
			var stateState = React.useState(null);
			var state = stateState[0];
			var setState = stateState[1];
			var cancelRef = React.useRef(null);
			var sessionIdRef = React.useRef(props.sessionId);
			var draftRef = React.useRef('');
			var panelOpenState = React.useState(false);
			var panelOpen = panelOpenState[0];
			var setPanelOpen = panelOpenState[1];
			var announceState = React.useState('');
			var setAnnounce = announceState[1];
			var tplBtnRef = React.useRef(null);
			var panelRef = React.useRef(null);

			// 新版 DSH 的 conversation.input.left 由 InputBar 内部以空 ownerProps 渲染，
			// 不再把 input snapshot 作为 props.input 传入；这里优先用标准 useInput hook
			// 读取草稿，旧 host 仍保留 props.input 回退。
			var inputSnapshot = null;
			if (typeof props.useInput === 'function') {
				inputSnapshot = props.useInput(function (state) { return state; });
			}
			if (!inputSnapshot || typeof inputSnapshot.draft !== 'string') {
				inputSnapshot = props.input && typeof props.input.draft === 'string' ? props.input : null;
			}
			var draft = inputSnapshot ? inputSnapshot.draft : '';
			sessionIdRef.current = props.sessionId;
			// Keep the latest host draft visible to an async response. The closure captured
			// at click time must never overwrite text the user edited while waiting.
			draftRef.current = draft;
			React.useEffect(function () {
				// Session switches and unmounts invalidate the in-flight request. The request
				// object is marked first so a fetch implementation without AbortController
				// still cannot commit stale output.
				return function () {
					var request = cancelRef.current;
					if (request === null) return;
					request.canceled = true;
					if (request.controller) request.controller.abort();
					if (cancelRef.current === request) cancelRef.current = null;
				};
			}, [props.sessionId]);
			// A session-change cleanup can invalidate the request before its promise settles;
			// compare the request's session as well, so the new render is immediately idle.
			var activeRequest = cancelRef.current;
			var stateForSession = state !== null && state.sessionId === props.sessionId;
			var busy = stateForSession && state.busy === true && activeRequest !== null
				&& activeRequest.sessionId === props.sessionId;
			var undoInfo = stateForSession && state.busy !== true && state.original !== undefined ? state : null;
			var canUndo = undoInfo !== null && draft === undoInfo.optimized;
			var errorText = stateForSession && state.busy !== true && typeof state.error === 'string' ? state.error : null;
			// 上下文类模板本次没读到对话上下文时的轻提示（不是错误，不红闪）。
			var noticeText = stateForSession && state.busy !== true && typeof state.notice === 'string' ? state.notice : null;

			// 模板目录变化后校正选择（类别被移除、模板不存在等）。
			React.useEffect(function () {
				if (templates === null) return;
				setSel(function (prev) {
					if (CATEGORY_ORDER.some(function (c) { return c === prev.category; })
						&& categoryTemplatesOf(templates, prev.category).length > 0) return prev;
					var category = CATEGORY_ORDER.find(function (c) { return categoryTemplatesOf(templates, c).length > 0; });
					if (category === undefined) return prev;
					return { category: category, byCategory: prev.byCategory };
				});
			}, [templates]);

			// 拉取模板目录（模块级缓存：会话切换/组件重挂载不再重复请求；
			// 模板随宿主启动固定，页面生命周期内缓存是安全的）。失败静默落禁用态。
			React.useEffect(function () {
				if (catalogCache !== null) {
					setTemplates(catalogCache);
					return undefined;
				}
				var alive = true;
				fetch(TEMPLATES_URL)
					.then(function (r) { return r.json(); })
					.then(function (body) {
						if (alive && body && body.ok && Array.isArray(body.templates) && body.templates.length > 0) {
							catalogCache = body.templates;
							setTemplates(body.templates);
						}
					})
					.catch(function () { /* 禁用态兜底 */ });
				return function () { alive = false; };
			}, []);

			// 错误红闪 4 秒自动清除（仅清错误态；若用户已再次发起优化则不打断 busy）。
			React.useEffect(function () {
				if (errorText === null) return undefined;
				var timer = setTimeout(function () {
					setState(function (prev) {
						return prev !== null && prev.busy !== true && typeof prev.error === 'string' ? null : prev;
					});
				}, 4000);
				return function () { clearTimeout(timer); };
			}, [errorText]);

			// 轻提示 5 秒后自动消失；只清 notice 字段，不影响撤销态。
			React.useEffect(function () {
				if (noticeText === null) return undefined;
				var timer = setTimeout(function () {
					setState(function (prev) {
						if (prev === null || prev.busy === true || typeof prev.notice !== 'string') return prev;
						var next = Object.assign({}, prev);
						delete next.notice;
						return next;
					});
				}, 5000);
				return function () { clearTimeout(timer); };
			}, [noticeText]);

			// 富下拉：外部点击 / Esc 时关闭。面板为 CSS 绝对定位（锚定模板按钮），
			// 随按钮自动对齐，滚动/缩放不漂移，无需关闭。
			React.useEffect(function () {
				if (!panelOpen) return undefined;
				var onPointerDown = function (e) {
					if (panelRef.current && panelRef.current.contains(e.target)) return;
					if (tplBtnRef.current && tplBtnRef.current.contains(e.target)) return;
					setPanelOpen(false);
				};
				var onKeyDown = function (e) { if (e.key === 'Escape') setPanelOpen(false); };
				document.addEventListener('pointerdown', onPointerDown, true);
				document.addEventListener('keydown', onKeyDown, true);
				window.addEventListener('blur', close);
				function close() { setPanelOpen(false); }
				return function () {
					document.removeEventListener('pointerdown', onPointerDown, true);
					document.removeEventListener('keydown', onKeyDown, true);
					window.removeEventListener('blur', close);
				};
			}, [panelOpen]);

			if (templates === null) {
				// 目录未就绪：占位（不占空间——返回 null 会让插槽空，但需保留拉取 effect）。
				return null;
			}

			var categoryTemplates = templates.filter(function (t) { return t.category === sel.category; });
			var currentId = sel.byCategory[sel.category];
			var current = categoryTemplates.find(function (t) { return t.id === currentId; }) ?? categoryTemplates[0] ?? null;

			function pickCategory(e) {
				var category = e.target.value;
				setSel(function (prev) {
					var remembered = prev.byCategory[category];
					var id = categoryTemplatesOf(templates, category).some(function (t) { return t.id === remembered; })
						? remembered
						: defaultTemplateId(templates, category);
					var byCategory = Object.assign({}, prev.byCategory);
					if (id !== null) byCategory[category] = id;
					var next = { category: category, byCategory: byCategory };
					saveSelection(next);
					return next;
				});
			}

			function pickTemplate(t) {
				setPanelOpen(false);
				setSel(function (prev) {
					var byCategory = Object.assign({}, prev.byCategory);
					byCategory[prev.category] = t.id;
					var next = { category: prev.category, byCategory: byCategory };
					saveSelection(next);
					return next;
				});
				setAnnounce('已选择模板：' + t.name);
			}

			function onButtonClick() {
				// 优化中再点 = 取消（客户端断开，宿主中止模型调用）。
				if (busy) {
					var activeRequest = cancelRef.current;
					if (activeRequest !== null) {
						// 先标记再 abort：即使 fetch 不支持 AbortController，旧响应也不能
						// 在用户开始下一次优化后写回页面。
						activeRequest.canceled = true;
						if (activeRequest.controller) activeRequest.controller.abort();
						if (cancelRef.current === activeRequest) cancelRef.current = null;
					}
					setState(null);
					setAnnounce('已取消优化');
					return;
				}
				// 成功后且草稿未被编辑 = 撤销恢复原文。
				if (canUndo) {
					props.inputActions.setDraft(undoInfo.original);
					setState(null);
					setAnnounce('已恢复优化前的原文');
					return;
				}
				if (draft.trim() === '' || current === null) return;
				var controller = typeof AbortController === 'function' ? new AbortController() : null;
				var request = { controller: controller, original: draft, sessionId: props.sessionId, category: current.category, canceled: false };
				var isCurrentRequest = function () {
					return !request.canceled && cancelRef.current === request
						&& request.sessionId === sessionIdRef.current
						&& !(controller && controller.signal.aborted);
				};
				cancelRef.current = request;
				setState({ busy: true, sessionId: request.sessionId });
				fetch(OPTIMIZE_URL, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ templateId: current.id, text: request.original, sessionId: props.sessionId }),
					signal: controller ? controller.signal : undefined,
				})
					.then(function (r) {
						if (!r.ok) throw new Error('HTTP ' + r.status);
						return r.json();
					})
					.then(function (body) {
						if (!isCurrentRequest()) return;
						if (body && body.ok && typeof body.text === 'string' && body.text.length > 0) {
							// The input may have changed while the model was running. Preserve the
							// user's latest draft instead of silently replacing it with stale output.
							if (draftRef.current !== request.original) {
								setState(null);
								setAnnounce('草稿已修改，未覆盖当前内容');
								return;
							}
							props.inputActions.setDraft(body.text);
							// 上下文类模板拿到 contextChars === 0 = 这次没带上会话上下文
							// （会话没读到 / 未启用 / 第一条消息），提示用户结果只基于草稿本身。
							var missedContext = request.category === 'context' && body.contextChars === 0;
							setState(Object.assign(
								{ sessionId: request.sessionId, original: request.original, optimized: body.text },
								missedContext ? { notice: '未带上下文' } : null,
							));
							setAnnounce(missedContext ? '提示词已优化，但本次没有读到对话上下文' : '提示词已优化，再次点击可恢复原文');
						} else if (body && body.error === 'canceled') {
							setState(null);
							setAnnounce('已取消优化');
						} else if (body && body.error === 'timeout') {
							setState({ sessionId: request.sessionId, error: (typeof body.message === 'string' && body.message) || '优化超时' });
							setAnnounce('优化超时');
						} else {
							setState({ sessionId: request.sessionId, error: (body && typeof body.error === 'string' && body.error) || '优化失败，请重试' });
							setAnnounce('优化失败');
						}
					})
					.catch(function () {
						if (!isCurrentRequest()) return;
						setState({ sessionId: request.sessionId, error: '优化请求失败（宿主不可达？）' });
						setAnnounce('优化失败');
					})
					.finally(function () {
						// A canceled request can finish after a replacement request started;
						// never clear the replacement's controller or busy state.
						if (cancelRef.current !== request || request.sessionId !== sessionIdRef.current) return;
						cancelRef.current = null;
						// busy 结束后由 then 分支决定终态；这里仅兜底清 busy。
						setState(function (prev) { return prev !== null && prev.busy === true ? null : prev; });
					});
			}

			var buttonChildren = SparklesIcon;
			var buttonTitle = '优化提示词（' + (current !== null ? current.name : '无模板') + '）';
			var buttonClass = 'dpo-btn';
			if (busy) {
				buttonChildren = SpinnerIcon;
				buttonTitle = '正在优化…（再次点击取消）';
			} else if (canUndo) {
				buttonChildren = UndoIcon;
				buttonTitle = '恢复优化前的提示词';
				buttonClass += ' is-undo';
			} else if (errorText !== null) {
				buttonTitle = '优化失败：' + errorText;
				buttonClass += ' has-error';
			}

			// 面板为 CSS 绝对定位（.dpo-tpl-wrap 相对锚定，bottom 向上弹出），
			// 无需 JS 计算坐标——对齐由浏览器保证。

			return React.createElement(
				React.Fragment,
				null,
				React.createElement(
					'span',
					{ className: 'dpo-bar' },
					React.createElement('select', {
						className: 'dpo-cat',
						value: sel.category,
						onChange: pickCategory,
						title: '优化模板类别',
						'aria-label': '优化模板类别',
					}, CATEGORY_ORDER.filter(function (c) { return templates.some(function (t) { return t.category === c; }); }).map(function (c) {
						return React.createElement('option', { key: c, value: c }, CATEGORY_NAMES[c] ?? c);
					})),
					React.createElement(
						'span',
						{ className: 'dpo-tpl-wrap' },
						React.createElement(
							'button',
							{
								type: 'button',
								ref: tplBtnRef,
								className: 'dpo-tpl',
								onClick: function () { setPanelOpen(function (open) { return !open; }); },
								title: current !== null ? current.name + '：' + current.desc : '选择优化模板',
								'aria-label': '选择优化模板',
								'aria-haspopup': 'listbox',
								'aria-expanded': panelOpen,
								disabled: busy,
							},
							React.createElement('span', { className: 'dpo-tpl-label' }, current !== null ? current.name : '选择模板'),
							React.createElement('span', { className: 'dpo-caret', 'aria-hidden': true }, '▼'),
						),
						panelOpen && current !== null
							? React.createElement(
								'div',
								{ className: 'dpo-panel', ref: panelRef, role: 'listbox', 'aria-label': '优化模板列表' },
								categoryTemplates.map(function (t) {
									var active = t.id === current.id;
									return React.createElement(
										'div',
										{
											key: t.id,
											className: 'dpo-item' + (active ? ' is-active' : ''),
											role: 'option',
											'aria-selected': active,
											onClick: function () { pickTemplate(t); },
										},
										React.createElement(
											'div',
											{ className: 'dpo-item-body' },
											React.createElement('div', { className: 'dpo-item-name' }, t.name),
											React.createElement('div', { className: 'dpo-item-desc' }, t.desc),
										),
										active ? React.createElement('span', { className: 'dpo-item-check', 'aria-hidden': true }, '✓') : null,
									);
								}),
							)
							: null,
					),
					React.createElement('button', {
						type: 'button',
						className: buttonClass,
						onClick: onButtonClick,
						disabled: !busy && !canUndo && (draft.trim() === '' || current === null),
						title: buttonTitle,
						'aria-label': busy ? '取消优化' : canUndo ? '恢复优化前的提示词' : '优化提示词',
					}, React.createElement(buttonChildren)),
					noticeText === null
						? null
						: React.createElement('span', { className: 'dpo-notice', title: '这次没有读到本会话的对话上下文，优化结果只基于输入框里的草稿' }, noticeText),
					React.createElement('span', { role: 'status', 'aria-live': 'polite', className: 'dpo-visually-hidden' }, announceState[0]),
				),
			);
		}

		function categoryTemplatesOf(templates, category) {
			return templates.filter(function (t) { return t.category === category; });
		}

		// 设置 → Plugins → Plugin configuration 的插件卡片：读写宿主注册的
		// `dsh-prompt-optimizer` 设置命名空间（settingsScope 服务）。
		var SETTINGS_NS = 'dsh-prompt-optimizer';
		var SETTINGS_FIELDS = [
			{ key: 'provider', label: '模型提供方', hint: '留空 = 跟随 DSH 默认模型', type: 'text' },
			{ key: 'model', label: '模型 ID', hint: '与提供方需同时配置', type: 'text' },
			{ key: 'reasoningEffort', label: '推理强度', hint: 'inherit=跟随模型默认；调低可显著加快优化速度。各家模型支持的档位不同（例如 DeepSeek 没有「中」），模型拒绝时本次优化自动回退到模型默认档位', type: 'select',
				options: [['inherit', '跟随模型默认'], ['off', '关闭'], ['low', '低'], ['medium', '中'], ['high', '高'], ['max', '最高']] },
			{ key: 'temperature', label: '采样温度', hint: '0–2，步进 0.1', type: 'number', min: 0, max: 2, step: 0.1 },
			{ key: 'maxTokens', label: '单次输出 token 上限', type: 'number', min: 64, step: 1 },
			{ key: 'timeoutMs', label: '单次优化超时（毫秒）', type: 'number', min: 1000, step: 1000 },
			{ key: 'maxInputChars', label: '待优化文本长度上限（字符）', type: 'number', min: 200, step: 500 },
			{ key: 'contextMaxMessages', label: '上下文类模板携带的最近对话条数', hint: '0=关闭，最多 200 条', type: 'number', min: 0, max: 200, step: 1 },
			{ key: 'contextMaxChars', label: '上下文文本总长上限（字符）', type: 'number', min: 200, step: 500 },
		];

		function ensureSettingsStyles() {
			if (document.getElementById('dpo-settings-style')) return;
			var style = document.createElement('style');
			style.id = 'dpo-settings-style';
			style.textContent = [
				'.dpo-set{max-width:640px;font-size:13px;line-height:1.6;color:var(--dsw-alias-text-primary,inherit)}',
				'.dpo-set-intro{color:var(--dsw-alias-label-secondary,#999);font-size:12px;margin:0 0 12px}',
				'.dpo-set-row{display:flex;align-items:center;gap:10px;margin-bottom:10px}',
				'.dpo-set-label{flex:none;width:230px;color:var(--dsw-alias-text-primary,inherit)}',
				'.dpo-set-input{flex:1;box-sizing:border-box;padding:5px 8px;font-size:13px;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-text-primary,inherit)}',
				'.dpo-set-input:focus{outline:2px solid var(--dsw-alias-brand-primary,#4a9eff);outline-offset:0;border-color:transparent}',
				'.dpo-set-hint{color:var(--dsw-alias-label-secondary,#999);font-size:11px;margin:0 0 10px 240px}',
				'.dpo-set-saved{color:var(--dsw-alias-state-success-primary,#2ecc71);font-size:12px;margin-left:8px}',
			].join('');
			document.head.appendChild(style);
		}

		/**
		 * 设置 → 侧边栏「提示词优化」独立分区页（settings.section 插槽，
		 * 与「会话管理」同款机制）：标题 + 表单，读写宿主注册的设置命名空间。
		 */
		function PromptOptimizerSection() {
			ensureSettingsStyles();
			var scopeState = React.useState(null);
			var scope = scopeState[0];
			var setScope = scopeState[1];
			var snapState = React.useState(null);
			var snap = snapState[0];
			var setSnap = snapState[1];
			var savedState = React.useState('');
			var saved = savedState[0];
			var setSaved = savedState[1];
			var formState = React.useState({});
			var formValues = formState[0];
			var setFormValues = formState[1];
			var binderVersionState = React.useState(0);
			var binderVersion = binderVersionState[0];
			var setBinderVersion = binderVersionState[1];
			React.useEffect(function () {
				var listener = function () { setBinderVersion(function (version) { return version + 1; }); };
				settingsBinderListeners.add(listener);
				return function () { settingsBinderListeners.delete(listener); };
			}, []);
			React.useEffect(function () {
				var binder = settingsBinder;
				// settingsScope 在旧 host 中可能不存在；设置分区应保持可渲染，
				// 并在服务稍后出现时由 binderVersion 触发重新绑定。
				if (binder === null || binder === undefined || typeof binder.bind !== 'function') {
					setScope(null);
					setSnap(null);
					return undefined;
				}
				var bound;
				var snapshot;
				try {
					bound = binder.bind({ namespace: SETTINGS_NS });
					if (bound === null || bound === undefined || typeof bound.getSnapshot !== 'function') {
						setScope(null);
						setSnap(null);
						return undefined;
					}
					snapshot = bound.getSnapshot();
				} catch (err) {
					console.error('dsh-prompt-optimizer: settings scope bind failed', err);
					setScope(null);
					setSnap(null);
					return undefined;
				}
				setScope(bound);
				setSnap(snapshot !== null && typeof snapshot === 'object' ? snapshot : null);
				if (typeof bound.subscribe !== 'function') return undefined;
				return bound.subscribe(function () {
					try {
						var next = bound.getSnapshot();
						setSnap(next !== null && typeof next === 'object' ? next : null);
					} catch (err) { console.error('dsh-prompt-optimizer: settings snapshot failed', err); }
				});
			}, [binderVersion]);
			React.useEffect(function () {
				if (snap === null || typeof snap !== 'object' || snap.value === null || typeof snap.value !== 'object') return;
				setFormValues(Object.assign({}, snap.value));
			}, [snap]);
			function commit(key, raw, def) {
				if (scope === null || typeof scope.set !== 'function') return;
				var value = raw;
				if (def.type === 'number') {
					// 清空/非法输入直接忽略，保留当前值（避免把 0 提交进设置导致调用失败）。
					if (typeof raw !== 'string' || raw.trim() === '') return;
					var n = Number(raw);
					if (!Number.isFinite(n)) return;
					value = n;
				}
				Promise.resolve()
					.then(function () { return scope.set(key, value); })
					.then(function () { setSaved('已保存 ' + def.label); })
					.catch(function (err) { setSaved('保存失败：' + (err instanceof Error ? err.message : String(err))); });
			}
			var resolved = snap !== null && snap.value !== null && typeof snap.value === 'object' ? snap.value : {};
			// Disable controls until the scoped settings snapshot is ready; otherwise an
			// early edit looks accepted even though commit() has nowhere to write it.
			var writable = snap !== null && typeof snap === 'object'
				&& snap.value !== null && typeof snap.value === 'object' && snap.writable !== false;
			var rows = SETTINGS_FIELDS.map(function (def) {
				var current = formValues[def.key] !== undefined ? formValues[def.key] : resolved[def.key];
				var currentText = current === undefined || current === null ? '' : String(current);
				var input;
				if (def.type === 'select') {
					input = React.createElement('select', {
						id: 'dpo-set-' + def.key,
						className: 'dpo-set-input',
						value: currentText,
						disabled: !writable,
						onChange: function (e) {
							var value = e.target.value;
							setFormValues(function (prev) { return Object.assign({}, prev, { [def.key]: value }); });
							commit(def.key, value, def);
						},
					}, def.options.map(function (opt) {
						return React.createElement('option', { key: opt[0], value: opt[0] }, opt[1]);
					}));
				} else {
					input = React.createElement('input', {
						id: 'dpo-set-' + def.key,
						className: 'dpo-set-input',
						type: def.type === 'number' ? 'number' : 'text',
						min: def.min, max: def.max, step: def.step,
						value: currentText,
						disabled: !writable,
						onChange: function (e) {
							var value = e.target.value;
							setFormValues(function (prev) { return Object.assign({}, prev, { [def.key]: value }); });
						},
						onBlur: function (e) { commit(def.key, e.target.value, def); },
						onKeyDown: function (e) { if (e.key === 'Enter') e.target.blur(); },
					});
				}
				return React.createElement(
					React.Fragment,
					{ key: def.key },
					React.createElement('div', { className: 'dpo-set-row' },
						React.createElement('label', { className: 'dpo-set-label', htmlFor: 'dpo-set-' + def.key }, def.label),
						input,
						saved.indexOf(def.label) >= 0 ? React.createElement('span', { className: 'dpo-set-saved' }, saved) : null,
					),
					def.hint ? React.createElement('div', { className: 'dpo-set-hint' }, def.hint) : null,
				);
			});
			return React.createElement(
				'div',
				{ className: 'dpo-set' },
				React.createElement(
					'div',
					{ style: { marginBottom: 14 } },
					React.createElement('div', { style: { fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-text-primary,inherit)' } }, '提示词优化'),
					React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary,#999)', marginTop: 2 } },
						'dsh-prompt-optimizer · 模型路由与优化参数'),
				),
				React.createElement('p', { className: 'dpo-set-intro' },
					'优化模板自带内置默认值，以下均可留空/不改。模型提供方与模型 ID 同时配置时覆盖 DSH 默认模型；其余项改动即时生效并持久化。输入框工具行的 ✨ 按钮即一键优化。'),
				rows,
			);
		}

		var settingsBinder = null;
		var settingsBinderListeners = new Set();
		function updateSettingsBinder(binder) {
			settingsBinder = binder === undefined || binder === null ? null : binder;
			settingsBinderListeners.forEach(function (listener) {
				try { listener(); } catch (error) { console.error('dsh-prompt-optimizer: settings listener failed', error); }
			});
		}

		/**
		 * Mount the composer tool-row controls and the settings sidebar section.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			var slots = ctx.slots;
			if (slots === undefined) return;
			// settingsScope is optional across DSH host revisions. Keep the toolbar
			// available and bind the settings page when the service appears later.
			updateSettingsBinder(typeof ctx.get === 'function' ? ctx.get('settingsScope') : undefined);
			try {
				if (typeof ctx.inject === 'function') {
					ctx.inject(['settingsScope'], function (scoped) {
						updateSettingsBinder(scoped && scoped.settingsScope);
					});
				}
			} catch {
				// Dynamic client facades may expose optional lookup but not nested inject;
				// settings enhancement is best-effort and must not remove the toolbar.
				console.debug?.('dsh-prompt-optimizer: optional settings injection unavailable');
			}
			slots.inject('conversation.input.left', function () {
				return slots.register(
					{ name: 'conversation.input.left', id: 'dsh-prompt-optimizer', order: 10, label: '优化提示词' },
					PromptOptimizerBar,
				);
			});
			// 设置 → 侧边栏「提示词优化」独立分区（不在 Plugins 插件页里堆配置）。
			slots.inject('settings.section', function () {
				return slots.register(
					{ name: 'settings.section', id: 'dsh-prompt-optimizer', order: 45, label: '提示词优化' },
					PromptOptimizerSection,
				);
			});
		}

		exports.name = 'dsh-prompt-optimizer-client';
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
