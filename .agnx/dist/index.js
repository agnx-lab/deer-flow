var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// .agnx/src/index.ts
var index_exports = {};
__export(index_exports, {
  activate: () => activate,
  appId: () => appId,
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);

// .agnx/src/constants.ts
var DEER_FLOW_APP_ID = "deer-flow";
var DEER_FLOW_PANEL_ID = "deer-flow.main";
var DEER_FLOW_OPEN_COMMAND_ID = "deer-flow.open";
var DEER_FLOW_ENSURE_TOOL_REL = ".agnx/tools/ensure-deer-flow.mjs";
var DEER_FLOW_DEFAULT_PORT = 8122;
var DEER_FLOW_DEFAULT_ENTITY_ID = "page:workspace";

// .agnx/src/panel.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var WEB_ROOT_STYLE = {
  flex: "1 1 0%",
  alignSelf: "stretch",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative"
};
var GUEST_HOST_STYLE = {
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative"
};
var LAYER = {
  position: "absolute",
  inset: 0,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  background: "rgb(9,9,11)"
};
var ERROR_TEXT_STYLE = {
  margin: "auto",
  maxWidth: 560,
  padding: 24,
  color: "rgb(248,113,113)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all"
};
var boundHost = null;
function bindDeerFlowHost(host2) {
  boundHost = host2;
}
function host() {
  if (!boundHost) throw new Error("DeerFlow host \u672A\u7ED1\u5B9A");
  return boundHost;
}
function DeerFlowPanel() {
  const guestHostRef = (0, import_react.useRef)(null);
  const [booting, setBooting] = (0, import_react.useState)(true);
  const [error, setError] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    const h = host();
    h.background?.requestRetain?.({
      appId: DEER_FLOW_APP_ID,
      active: true,
      reason: "deer-flow-open"
    });
    return () => {
      h.background?.requestRetain?.({
        appId: DEER_FLOW_APP_ID,
        active: false,
        reason: "deer-flow-open"
      });
    };
  }, []);
  (0, import_react.useEffect)(() => {
    const h = host();
    if (!h.guest?.mount || !guestHostRef.current) {
      setBooting(false);
      setError("\u5BBF\u4E3B\u672A\u63D0\u4F9B host.guest.mount\uFF08\u9700\u5347\u7EA7 Agnx \u5E76\u91CD\u65B0\u626B\u63CF\u5B50\u5E94\u7528\uFF09");
      return;
    }
    let cancelled = false;
    const unmount = h.guest.mount({
      container: guestHostRef.current,
      ensureTool: DEER_FLOW_ENSURE_TOOL_REL,
      ensureArgs: ["--port", String(DEER_FLOW_DEFAULT_PORT)],
      // 首次挂载要走 uv/pnpm 依赖就绪后的冷启动：LangGraph + Gateway + Next dev
      timeoutMs: 6e5,
      surfaceReadyTimeoutMs: 18e4,
      bootOverlay: false,
      onReady: () => {
        if (cancelled) return;
        window.setTimeout(() => {
          if (!cancelled) setBooting(false);
        }, 320);
      },
      onError: (detail) => {
        if (cancelled) return;
        setBooting(false);
        setError(`${detail.code}: ${detail.message}`);
      }
    });
    return () => {
      cancelled = true;
      unmount?.();
    };
  }, []);
  const BrandPanel = host().ui?.BrandLogoLoaderPanel;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      style: WEB_ROOT_STYLE,
      "data-testid": `workspace-mini-app-${DEER_FLOW_APP_ID}-root`,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "div",
          {
            ref: guestHostRef,
            "data-agnx-guest-surface-host": "true",
            style: GUEST_HOST_STYLE
          }
        ),
        booting && !error && BrandPanel ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "div",
          {
            "data-agnx-guest-boot-overlay": "true",
            style: LAYER,
            role: "status",
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(BrandPanel, { title: "\u6B63\u5728\u542F\u52A8 DeerFlow\u2026", testID: "deer-flow-boot-overlay" })
          }
        ) : null,
        error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: LAYER, role: "alert", "data-deer-flow-error": "1", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: ERROR_TEXT_STYLE, children: error }) }) : null
      ]
    }
  );
}

// .agnx/src/index.ts
var appId = DEER_FLOW_APP_ID;
function activate(host2) {
  bindDeerFlowHost(host2);
  const disposers = [];
  disposers.push(
    host2.registerMiniApp({
      id: DEER_FLOW_PANEL_ID,
      appId: DEER_FLOW_APP_ID,
      title: "DeerFlow",
      component: DeerFlowPanel,
      primaryPanel: true,
      defaultEntityId: DEER_FLOW_DEFAULT_ENTITY_ID,
      // entityLabel 是「实体缺名时的兜底名」，会直接成为 Tab 标题。
      // 之前写成「工作台」，Tab 上就显示「工作台」而不是 DeerFlow，与面板 title 冲突。
      entityLabel: "DeerFlow",
      // 上游工作台的输入框是多行文本，纯单键快捷键要靠这个开关才会投递进 iframe
      iframeShortcutCapture: true
    })
  );
  disposers.push(
    host2.registerCommand({
      id: DEER_FLOW_OPEN_COMMAND_ID,
      appId: DEER_FLOW_APP_ID,
      title: "DeerFlow",
      keywords: ["deerflow", "deer", "research", "superagent", "\u6DF1\u5EA6\u7814\u7A76"],
      sidebarAction: {
        defaultVisible: true,
        label: "DeerFlow",
        order: 60
      },
      run: (context) => {
        host2.openSubAppTab({
          appId: DEER_FLOW_APP_ID,
          panelId: DEER_FLOW_PANEL_ID,
          entityId: DEER_FLOW_DEFAULT_ENTITY_ID,
          serverId: context?.serverId,
          workspaceId: context?.workspaceId,
          currentPathname: context?.currentPathname
        });
      }
    })
  );
  return () => {
    for (const dispose of disposers.toReversed()) dispose();
  };
}
var moduleExport = { appId: DEER_FLOW_APP_ID, activate };
var index_default = moduleExport;
