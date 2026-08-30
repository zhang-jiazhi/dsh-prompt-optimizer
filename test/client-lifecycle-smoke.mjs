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
global.window.__ModuleLoader__ = {
  load: ({ factory }) => { captured.exports = factory((name) => name === 'react' ? React : {}); },
};
new vm.Script(source, { filename: 'client.js' }).runInThisContext();

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

const templates = [{ id: 'general-optimize', name: '通用优化', desc: 'test', category: 'basic' }];
const optimizeRequests = [];
global.fetch = (url, options) => {
  if (url.endsWith('/templates')) return Promise.resolve({ ok: true, json: async () => ({ ok: true, templates }) });
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
function resolveRequest(request, body) {
  request.resolve({ ok: true, json: async () => body });
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

console.log('client lifecycle: manual edit, cancel/retry, and unmount guards passed');
