// DeerFlow 桌面端验收驱动：连 CDP 9333，先切到 DeerFlow Tab，再操作其 OOPIF（127.0.0.1:8122），最后截整窗
// 用法：node deer-desktop.mjs <action> [args]
//   action: inspect | shot <path> | type <text> | click <selectorOrText> | keys <key> | eval <expr>

import { createRequire } from "node:module";

// ws 由宿主 Agnx 仓提供；用 AGNX_MONOREPO_ROOT 定位，不写死本机绝对路径
const require_ = createRequire(import.meta.url);
const wsEntry = process.env.AGNX_MONOREPO_ROOT
  ? `${process.env.AGNX_MONOREPO_ROOT}/node_modules/ws/index.js`
  : "ws";
const WebSocket = require_(wsEntry);

const BASE = process.env.AGNX_CDP_URL || "http://127.0.0.1:9333";

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  let seq = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, close: () => ws.close() };
}

async function shellPage() {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && /localhost:8083\/h\//.test(t.url || ""));
  if (!page) throw new Error("找不到 Dev 壳 page");
  return page;
}

async function deerFrame() {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const frame = list.find((t) => t.type === "iframe" && /127\.0\.0\.1:8122/.test(t.url || ""));
  if (!frame) throw new Error("找不到 deer-flow 的 iframe target（:8122）");
  return frame;
}

async function evalIn(wsUrl, expression, awaitPromise = true) {
  const c = await connect(wsUrl);
  try {
    const r = await c.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    return r.result?.value;
  } finally {
    c.close();
  }
}

const [action, ...rest] = process.argv.slice(2);

const shell = await shellPage();
const shellCdp = await connect(shell.webSocketDebuggerUrl);
await shellCdp.send("Page.enable");
await shellCdp.send("Runtime.enable");

// 1) 总是先把 DeerFlow Tab 切到前台（并行兄弟智能体会抢焦点）
const tabInfo = await evalIn(
  shell.webSocketDebuggerUrl,
  `(async()=>{
    const t=document.querySelector('[data-testid="workspace-tab-mini-app_deer-flow__deer-flow.main__page_workspace"]');
    if(!t) return {found:false};
    t.scrollIntoView({inline:'center',block:'nearest'});
    t.click();
    await new Promise(r=>setTimeout(r,1800));
    const root=document.querySelector('[data-testid="workspace-mini-app-deer-flow-root"]');
    const b=root?.getBoundingClientRect();
    return {found:true,selected:t.getAttribute('aria-selected'),box:b?{w:Math.round(b.width),h:Math.round(b.height)}:null};
  })()`,
);

if (action === "tab") {
  console.log(JSON.stringify(tabInfo));
  process.exit(0);
}

const frame = await deerFrame();
const frameUrl = frame.webSocketDebuggerUrl;

if (action === "inspect") {
  const info = await evalIn(
    frameUrl,
    `(()=>{
      const ta=document.querySelector('textarea');
      const btns=[...document.querySelectorAll('button')].map(b=>({t:(b.innerText||'').trim().slice(0,24),a:b.getAttribute('aria-label')||'',d:b.disabled})).filter(b=>b.t||b.a).slice(0,30);
      return {href:location.href,title:document.title,ta:{found:Boolean(ta),ph:ta?.getAttribute('placeholder')||null},btns,
        text:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,500)};
    })()`,
  );
  console.log(JSON.stringify({ tab: tabInfo, frame: info }, null, 1));
  process.exit(0);
}

if (action === "shot") {
  const out = rest[0];
  const data = await shellCdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, Buffer.from(data.data, "base64"));
  console.log(JSON.stringify({ ok: true, out, tab: tabInfo }));
  process.exit(0);
}

if (action === "type") {
  const text = rest.join(" ");
  const res = await evalIn(
    frameUrl,
    `(async()=>{
      const ta=document.querySelector('textarea');
      if(!ta) return {ok:false,error:'no textarea'};
      ta.focus();
      const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,600));
      return {ok:true,value:ta.value.slice(0,80)};
    })()`,
  );
  console.log(JSON.stringify(res));
  process.exit(0);
}

if (action === "click") {
  const sel = rest[0];
  const res = await evalIn(
    frameUrl,
    `(async()=>{
      const sel=${JSON.stringify(sel)};
      let el=document.querySelector(sel);
      if(!el){ el=[...document.querySelectorAll('button,[role="button"]')].find(b=>((b.innerText||'')+' '+(b.getAttribute('aria-label')||'')).includes(sel)); }
      if(!el) return {ok:false,error:'not found: '+sel};
      el.scrollIntoView({block:'center'});
      el.click();
      await new Promise(r=>setTimeout(r,1500));
      return {ok:true,tag:el.tagName,text:((el.innerText||el.getAttribute('aria-label'))||'').trim().slice(0,40)};
    })()`,
  );
  console.log(JSON.stringify(res));
  process.exit(0);
}

if (action === "keys") {
  const key = rest[0];
  const res = await evalIn(
    frameUrl,
    `(()=>{
      const ta=document.querySelector('textarea');
      if(!ta) return {ok:false,error:'no textarea'};
      ta.focus();
      return {ok:true};
    })()`,
  );
  const c = await connect(frameUrl);
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key === "Enter" ? "Enter" : key, windowsVirtualKeyCode: key === "Enter" ? 13 : 0, nativeVirtualKeyCode: key === "Enter" ? 13 : 0 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key === "Enter" ? "Enter" : key });
  c.close();
  console.log(JSON.stringify(res));
  process.exit(0);
}

if (action === "eval") {
  const expr = rest.join(" ");
  const res = await evalIn(frameUrl, expr);
  console.log(typeof res === "string" ? res : JSON.stringify(res, null, 1));
  process.exit(0);
}

console.error("unknown action", action);
process.exit(1);
