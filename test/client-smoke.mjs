// 客户端最小验证：用最小 React/DOM 替身加载 client.js，确认
//   1) 两个插槽（输入框工具行 + 设置分区）都注册成功；
//   2) 宿主未提供 settingsScope 时（undefined / null / 无 .bind），设置分区
//      仍能渲染而不抛异常 —— settingsBinder 初值是 null，只判 undefined 会白屏。
// 无需浏览器，node test/client-smoke.mjs 即可跑。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const src = fs.readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

const effects = [];
const React = {
  createElement: (t,p,...c)=>({t,p,c}),
  useState: (init)=>[typeof init==='function'?init():init, ()=>{}],
  useRef: ()=>({current:null}),
  useEffect: (fn)=>effects.push(fn),
  Fragment: 'Fragment',
};
const styleEls = new Map();
global.document = {
  getElementById: (id)=>styleEls.get(id) ?? null,
  createElement: ()=>({ set id(v){ this._id=v; }, get id(){return this._id;}, textContent:'' }),
  head: { appendChild: (el)=>styleEls.set(el.id, el) },
  addEventListener(){}, removeEventListener(){},
};
global.window = { localStorage:{ getItem:()=>null, setItem(){} }, addEventListener(){}, removeEventListener(){} };

let captured = {};
global.window.__ModuleLoader__ = { load: ({factory})=>{ captured.exports = factory((n)=> n==='react'?React:{}); } };
new (await import('node:vm')).Script(src, {filename:'client.js'}).runInThisContext();
if (JSON.stringify(captured.exports.inject) !== JSON.stringify(['slots'])) {
  throw new Error('settingsScope must remain a nested optional dependency');
}

const slotRegistry = [];
const slots = { inject:(name,cb)=>cb(), register:(meta,comp)=>{ slotRegistry.push({meta,comp}); return ()=>{}; } };

const failures = [];
for (const [label, settingsScope] of [['settingsScope = undefined', undefined],
                                      ['settingsScope = null (default!)', null],
                                      ['settingsScope = {} (no .bind)', {}]]) {
  effects.length = 0; slotRegistry.length = 0;
  captured.exports.apply({ slots, settingsScope });
  const section = slotRegistry.find(s=>s.meta.name==='settings.section');
  let verdict;
  try {
    section.comp();                       // render settings section
    effects.forEach(fn=>fn());            // run its effects (binder path)
    verdict = 'rendered OK, no throw';
  } catch (e) { verdict = 'THREW -> ' + e.constructor.name + ': ' + e.message; failures.push(label + ' ' + verdict); }
  console.log(label.padEnd(34), '|', verdict);
}
console.log('\nslots registered:', slotRegistry.map(s=>s.meta.name+'#'+s.meta.id).join(', '));
if (failures.length > 0) { console.error('\n失败: ' + failures.join('; ')); process.exit(1); }
if (slotRegistry.length !== 2) { console.error('\n失败: 插槽注册数不为 2'); process.exit(1); }

// The settings service may be injected after the client plugin mounts.
let bindCalls = 0;
const bound = {
  getSnapshot: () => ({ value: { provider: 'late-provider' }, writable: true }),
  subscribe: () => () => {},
  set: () => Promise.resolve(),
};
const lateBinder = { bind: () => { bindCalls += 1; return bound; } };
effects.length = 0; slotRegistry.length = 0;
const strictContext = {
  slots,
  get: () => undefined,
  inject: (deps, callback) => { if (deps[0] === 'settingsScope') callback({ settingsScope: lateBinder }); },
};
Object.defineProperty(strictContext, 'settingsScope', { get() { throw new Error('undeclared direct property read'); } });
captured.exports.apply(strictContext);
const lateSection = slotRegistry.find((s) => s.meta.name === 'settings.section');
lateSection.comp();
effects.forEach((fn) => fn());
if (bindCalls !== 1) throw new Error('late settingsScope was not bound through nested injection');

// A dynamic facade may expose optional lookup but reject nested injection verbs.
effects.length = 0; slotRegistry.length = 0;
const dynamicLikeContext = { slots, get: () => undefined };
Object.defineProperty(dynamicLikeContext, 'inject', { get() { throw new Error('inject is not exposed'); } });
captured.exports.apply(dynamicLikeContext);
if (slotRegistry.length !== 2) throw new Error('optional injection failure removed client slots');
console.log('dynamic-like facade: optional injection failure kept slots mounted');
console.log('late settingsScope: nested bind and snapshot path passed');
console.log('全部通过 ✅');
