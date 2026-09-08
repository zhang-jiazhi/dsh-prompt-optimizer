// Behavioral smoke test for the toolbar's async request lifecycle.
// It uses a tiny hook renderer so stale-response and cancellation races are
// exercised without adding a browser or test dependency.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = fs.readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
const styleEls = new Map();
global.document = {
  getElementById: (id) => styleEls.get(id) ?? null,
  createElement: () => ({ set id(value) { this._id = value; }, get id() { return this._id; }, textContent: '' }),
  head: { appendChild: (element) => styleEls.set(element.id, element) },
  addEventListener() {}, removeEventListener() {},
};
global.window = {
  localStorage: { getItem: () => null, setItem() {} },
  addEventListener() {}, removeEventListener() {},
};

let activeRenderer = null;
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => activeRenderer.useState(initial),
  useRef: (initial) => activeRenderer.useRef(initial),
  useEffect: (effect, deps) => activeRenderer.useEffect(effect, deps),
  Fragment: 'Fragment',
};
let captured = {};
function loadClientModule() {
  let exports = {};
  global.window.__ModuleLoader__ = {
    load: ({ factory }) => { exports = factory((name) => name === 'react' ? React : {}); },
  };
  new vm.Script(source, { filename: 'client.js' }).runInThisContext();
  return exports;
}
captured.exports = loadClientModule();

function createRenderer(component, props) {
  const hooks = [];
  let hookIndex = 0;
  let pendingEffects = [];
  let rendering = false;
  let rerenderRequested = false;
  let output = null;

  function schedule() {
    if (rendering) {
      rerenderRequested = true;
      return;
    }
    render();
  }
  function useState(initial) {
    const index = hookIndex++;
    if (!Object.prototype.hasOwnProperty.call(hooks, index)) hooks[index] = typeof initial === 'function' ? initial() : initial;
    const setState = (next) => {
      const value = typeof next === 'function' ? next(hooks[index]) : next;
      hooks[index] = value;
      schedule();
    };
    return [hooks[index], setState];
  }
  function useRef(initial) {
    const index = hookIndex++;
    if (!Object.prototype.hasOwnProperty.call(hooks, index)) hooks[index] = { current: initial };
    return hooks[index];
  }
  function useEffect(effect, deps) {
    const index = hookIndex++;
    const previous = hooks[index];
    const changed = previous === undefined || deps === undefined || previous.deps === undefined
      || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]));
    hooks[index] = { deps, cleanup: previous?.cleanup };
    if (changed) pendingEffects.push({ index, effect });
  }
  function render() {
    if (rendering) { rerenderRequested = true; return; }
    do {
      rerenderRequested = false;
      pendingEffects = [];
      rendering = true;
      hookIndex = 0;
      activeRenderer = { useState, useRef, useEffect };
      output = component(props);
      rendering = false;
      const effects = pendingEffects;
      for (const item of effects) {
        hooks[item.index].cleanup?.();
        hooks[item.index].cleanup = item.effect() ?? undefined;
      }
    } while (rerenderRequested);
    activeRenderer = null;
  }
  function unmount() {
    for (const hook of hooks) hook?.cleanup?.();
  }
  return { render, unmount, get output() { return output; } };
}

function findOptimizeButton(node) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (node.type === 'button' && typeof node.props?.onClick === 'function' && String(node.props.className ?? '').includes('dpo-btn')) return node;
  for (const child of node.children ?? []) {
    const found = findOptimizeButton(child);
    if (found !== null) return found;
  }
  return null;
}

const templates = [
  { id: 'general-optimize', name: '通用优化', desc: 'test', category: 'basic' },
  { id: 'user-task-optimize', name: '任务指令优化', desc: 'test', category: 'basic' },
  { id: 'context-message-optimize', name: '通用消息优化', desc: 'test', category: 'context' },
];
const optimizeRequests = [];
global.fetch = (url, options) => {
  if (url.endsWith('/templates')) return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, templates }) });
  return new Promise((resolve, reject) => {
    // Deliberately do not reject on abort. This models a transport that cannot
    // stop immediately and proves the request identity guard is still needed.
    optimizeRequests.push({ url, options, resolve, reject });
  });
};

const slotRegistry = [];
const slots = {
  inject: (_name, callback) => callback(),
  register: (meta, component) => { slotRegistry.push({ meta, component }); return () => {}; },
};
captured.exports.apply({ slots });
const bar = slotRegistry.find((entry) => entry.meta.name === 'conversation.input.left')?.component;
if (typeof bar !== 'function') throw new Error('toolbar slot was not registered');

const props = {
  sessionId: 'session-1',
  input: { draft: '原始草稿' },
  inputActions: {
    setDraft(value) { props.input.draft = value; renderer.render(); },
  },
};
const renderer = createRenderer(bar, props);
renderer.render();
for (let i = 0; i < 8; i++) await Promise.resolve();
if (renderer.output === null || optimizeRequests.length !== 0) throw new Error('template catalog did not settle');

function clickOptimize() {
  const button = findOptimizeButton(renderer.output);
  if (button === null) throw new Error('optimize button not found');
  button.props.onClick();
}
function resolveRequest(request, body, init) {
  const status = init?.status ?? 200;
  request.resolve({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
}

// 1. A manual edit while waiting must be preserved.
clickOptimize();
const manualRequest = optimizeRequests.at(-1);
props.input.draft = '用户在等待期间的新草稿';
renderer.render();
resolveRequest(manualRequest, { ok: true, text: '不应覆盖' });
for (let i = 0; i < 8; i++) await Promise.resolve();
if (props.input.draft !== '用户在等待期间的新草稿') throw new Error('late result overwrote a manual draft edit');

// 2. Cancel + immediate retry: the old request must not clear or overwrite the new one.
props.input.draft = '第一次请求';
renderer.render();
clickOptimize();
const canceledRequest = optimizeRequests.at(-1);
clickOptimize();
if (!canceledRequest.options.signal?.aborted) throw new Error('cancel did not abort the active request');
props.input.draft = '第二次请求';
renderer.render();
clickOptimize();
const replacementRequest = optimizeRequests.at(-1);
if (replacementRequest === canceledRequest) throw new Error('replacement request was not started');
resolveRequest(canceledRequest, { ok: true, text: '旧请求结果' });
for (let i = 0; i < 8; i++) await Promise.resolve();
if (props.input.draft !== '第二次请求') throw new Error('canceled request overwrote replacement draft');
resolveRequest(replacementRequest, { ok: true, text: '新请求结果' });
for (let i = 0; i < 8; i++) await Promise.resolve();
if (props.input.draft !== '新请求结果') throw new Error('replacement request did not commit its result');

// A successful state belongs to its session; it must not expose undo in a new one.
props.sessionId = 'session-2';
renderer.render();
const switchedButton = findOptimizeButton(renderer.output);
if (switchedButton?.props['aria-label'] === '恢复优化前的提示词') throw new Error('old session exposed an undo action');

// 3. A session switch must release busy state so the new session can run.
props.sessionId = 'session-1';
props.input.draft = '会话一请求';
renderer.render();
clickOptimize();
const oldSessionRequest = optimizeRequests.at(-1);
props.sessionId = 'session-2';
props.input.draft = '会话二草稿';
renderer.render();
if (!oldSessionRequest.options.signal?.aborted) throw new Error('session switch did not abort the old request');
clickOptimize();
const newSessionRequest = optimizeRequests.at(-1);
if (newSessionRequest === oldSessionRequest) throw new Error('session switch left toolbar stuck busy');
resolveRequest(oldSessionRequest, { ok: true, text: '旧会话结果' });
for (let i = 0; i < 8; i++) await Promise.resolve();
if (props.input.draft !== '会话二草稿') throw new Error('old session result overwrote new session draft');
resolveRequest(newSessionRequest, { ok: true, text: '新会话结果' });
for (let i = 0; i < 8; i++) await Promise.resolve();
if (props.input.draft !== '新会话结果') throw new Error('new session request did not commit');

// 4. Unmount cleanup aborts and invalidates the pending request.
props.input.draft = '卸载前草稿';
renderer.render();
clickOptimize();
const unmountedRequest = optimizeRequests.at(-1);
renderer.unmount();
if (!unmountedRequest.options.signal?.aborted) throw new Error('unmount did not abort the active request');
resolveRequest(unmountedRequest, { ok: true, text: '卸载后的旧结果' });
for (let i = 0; i < 8; i++) await Promise.resolve();
if (props.input.draft !== '卸载前草稿') throw new Error('unmounted request committed stale output');

// 5. 上下文类模板：宿主返回 contextChars === 0 表示本次没读到会话上下文，
//    工具行必须给出可见的轻提示，且不能把它当成错误、也不能影响撤销态。
function findByClass(node, className) {
  if (node === null || typeof node !== 'object') return null;
  if (node.props?.className === className) return node;
  for (const child of [...(node.children ?? []), ...(Array.isArray(node.props?.children) ? node.props.children : [])]) {
    const found = findByClass(child, className);
    if (found !== null) return found;
  }
  return null;
}
const ctxProps = {
  sessionId: 'session-ctx',
  input: { draft: '就按刚才说的那个方案改吧' },
  inputActions: { setDraft(value) { ctxProps.input.draft = value; ctxRenderer.render(); } },
};
const ctxRenderer = createRenderer(bar, ctxProps);
ctxRenderer.render();
for (let i = 0; i < 8; i++) await Promise.resolve();
const categorySelect = findByClass(ctxRenderer.output, 'dpo-cat');
if (categorySelect === null) throw new Error('category select not found');
categorySelect.props.onChange({ target: { value: 'context' } });
ctxRenderer.render();

function clickCtxOptimize() {
  const button = findOptimizeButton(ctxRenderer.output);
  if (button === null) throw new Error('optimize button not found');
  button.props.onClick();
}
clickCtxOptimize();
resolveRequest(optimizeRequests.at(-1), { ok: true, text: '没有上下文的结果', contextChars: 0 });
for (let i = 0; i < 8; i++) await Promise.resolve();
ctxRenderer.render();
if (findByClass(ctxRenderer.output, 'dpo-notice') === null) throw new Error('contextChars=0 did not surface the missing-context notice');
if (findOptimizeButton(ctxRenderer.output)?.props['aria-label'] !== '恢复优化前的提示词') throw new Error('notice broke the undo state');

ctxProps.input.draft = '再来一次';
ctxRenderer.render();
clickCtxOptimize();
resolveRequest(optimizeRequests.at(-1), { ok: true, text: '带上下文的结果', contextChars: 4006 });
for (let i = 0; i < 8; i++) await Promise.resolve();
ctxRenderer.render();
if (findByClass(ctxRenderer.output, 'dpo-notice') !== null) throw new Error('notice shown even though context was present');

// 6. 宿主返回非 2xx + JSON 错误体时，必须显示真实原因（而不是笼统的“宿主不可达”）。
{
  ctxProps.input.draft = '错误提示测试';
  ctxRenderer.render();
  clickCtxOptimize();
  resolveRequest(optimizeRequests.at(-1), { ok: false, error: 'forbidden: loopback-only' }, { status: 403 });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  ctxRenderer.render();
  const errorNotice = findByClass(ctxRenderer.output, 'dpo-notice is-error');
  if (errorNotice === null) throw new Error('403 did not surface a visible error notice');
  const errorText = String(errorNotice.children[0] ?? '');
  if (!errorText.includes('仅本机可用') || !errorText.includes('loopback-only')) {
    throw new Error('403 error body was not surfaced: ' + errorText);
  }
}

// 7. 质量告警 + 耗时/token 展示（同一行轻提示，不打断撤销）。
{
  ctxProps.input.draft = '告警展示测试';
  ctxRenderer.render();
  clickCtxOptimize();
  resolveRequest(optimizeRequests.at(-1), {
    ok: true,
    text: '优化后的结果',
    ms: 1234,
    usage: { inputTokens: 1234, outputTokens: 56 },
    warnings: [{ code: 'placeholder-missing', message: '有 1 个变量占位符未保留：{{x}}' }],
  });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  ctxRenderer.render();
  const notice = findByClass(ctxRenderer.output, 'dpo-notice');
  if (notice === null) throw new Error('warnings/stats notice not rendered');
  const noticeText = String(notice.children[0] ?? '');
  if (!noticeText.includes('⚠') || !noticeText.includes('耗时 1.2s') || !noticeText.includes('tokens 1.2k→56')) {
    throw new Error('warnings/stats notice content wrong: ' + noticeText);
  }
}

// 8. 优化中：类别选择器禁用、按钮变取消、显示计时；再次点击可取消。
{
  ctxProps.input.draft = '忙碌态测试';
  ctxRenderer.render();
  clickCtxOptimize();
  ctxRenderer.render();
  if (findByClass(ctxRenderer.output, 'dpo-cat')?.props.disabled !== true) throw new Error('category select not disabled while busy');
  if (findOptimizeButton(ctxRenderer.output)?.props['aria-label'] !== '取消优化') throw new Error('busy button label wrong');
  if (findByClass(ctxRenderer.output, 'dpo-notice dpo-timer') === null) throw new Error('busy timer not rendered');
  clickCtxOptimize(); // 再次点击 = 取消
  resolveRequest(optimizeRequests.at(-1), { ok: true, error: 'canceled' });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  ctxRenderer.render();
  if (findByClass(ctxRenderer.output, 'dpo-cat')?.props.disabled === true) throw new Error('category select stayed disabled after cancel');
}

// 9. 模板下拉键盘可达：面板有键盘处理、选项 roving tabindex、方向键/ Esc 生效。
{
  const basicSelect = findByClass(ctxRenderer.output, 'dpo-cat');
  basicSelect.props.onChange({ target: { value: 'basic' } });
  ctxRenderer.render();
  const tplButton = findByClass(ctxRenderer.output, 'dpo-tpl');
  if (tplButton === null) throw new Error('template button not found');
  tplButton.props.onClick();
  ctxRenderer.render();
  const panel = findByClass(ctxRenderer.output, 'dpo-panel');
  if (panel === null || typeof panel.props.onKeyDown !== 'function') throw new Error('template panel is not keyboard operable');
  function collectOptions(node, out) {
    if (node === null || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const item of node) collectOptions(item, out); return out; }
    if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes('dpo-item')) out.push(node);
    for (const child of [...(node.children ?? []), ...(Array.isArray(node.props?.children) ? node.props.children : [])]) collectOptions(child, out);
    return out;
  }
  const options = collectOptions(ctxRenderer.output, []);
  if (options.length < 2) throw new Error('expected at least two template options, got ' + options.length);
  for (const option of options) {
    if (option.props.tabIndex !== -1) throw new Error('template option is not focusable via roving tabindex');
    if (typeof option.props.onMouseEnter !== 'function') throw new Error('template option missing hover focus sync');
  }
  panel.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  ctxRenderer.render();
  const focusedOptions = collectOptions(ctxRenderer.output, []);
  if (!focusedOptions.some((option) => String(option.props.className).includes('is-focused'))) {
    throw new Error('ArrowDown did not move option focus');
  }
  findByClass(ctxRenderer.output, 'dpo-panel').props.onKeyDown({ key: 'Escape', preventDefault() {} });
  ctxRenderer.render();
  if (findByClass(ctxRenderer.output, 'dpo-panel') !== null) throw new Error('Escape did not close the template panel');
}

// 10. 目录加载失败：按钮不能消失，必须给出可见错误和重试入口。
{
  const realFetch = global.fetch;
  global.fetch = (url) => {
    if (url.endsWith('/templates')) {
      return Promise.resolve({ ok: false, status: 500, text: async () => JSON.stringify({ ok: false, error: 'catalog boom' }) });
    }
    return Promise.reject(new Error('unexpected fetch ' + url));
  };
  const fresh = loadClientModule();
  slotRegistry.length = 0;
  fresh.apply({ slots });
  const failBar = slotRegistry.find((entry) => entry.meta.name === 'conversation.input.left')?.component;
  const failProps = { sessionId: 's-fail', input: { draft: '草稿' }, inputActions: { setDraft() {} } };
  const failRenderer = createRenderer(failBar, failProps);
  failRenderer.render();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  failRenderer.render();
  const failButton = findOptimizeButton(failRenderer.output);
  if (failButton === null) throw new Error('catalog failure removed the toolbar entirely');
  if (failButton.props.disabled !== false) throw new Error('catalog failure should offer a retry button');
  if (!String(failButton.props.title).includes('模板目录加载失败')) throw new Error('catalog failure title missing: ' + failButton.props.title);
  failButton.props.onClick();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  failRenderer.render();
  if (findOptimizeButton(failRenderer.output) === null) throw new Error('retry removed the toolbar');
  global.fetch = realFetch;
  failRenderer.unmount();
}

ctxRenderer.unmount();
console.log('client lifecycle: manual edit, cancel/retry, unmount guards, missing-context notice, error body, warnings/stats, busy controls, keyboard a11y, and catalog failure passed');
