import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactElement,
} from "react";
import type {
  WorkspaceAppBrandLogoLoaderPanelProps,
  WorkspaceAppHostApi,
} from "@agnx-lab/app-sdk";

import {
  DEER_FLOW_APP_ID,
  DEER_FLOW_DEFAULT_PORT,
  DEER_FLOW_ENSURE_TOOL_REL,
} from "./constants";

// 满铺：根 + guest host 都不许有 padding / margin，否则 Tab 四周会出现 24px 白边。
const WEB_ROOT_STYLE: CSSProperties = {
  flex: "1 1 0%",
  alignSelf: "stretch",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
};
const GUEST_HOST_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
};
const LAYER: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  background: "rgb(9,9,11)",
};
const ERROR_TEXT_STYLE: CSSProperties = {
  margin: "auto",
  maxWidth: 560,
  padding: 24,
  color: "rgb(248,113,113)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

let boundHost: WorkspaceAppHostApi | null = null;

export function bindDeerFlowHost(host: WorkspaceAppHostApi): void {
  boundHost = host;
}

function host(): WorkspaceAppHostApi {
  if (!boundHost) throw new Error("DeerFlow host 未绑定");
  return boundHost;
}

export function DeerFlowPanel(): ReactElement {
  const guestHostRef = useRef<HTMLDivElement | null>(null);
  // 首帧即 true：在 await mount 之前盖住空 host，避免闪黑屏
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const h = host();
    h.background?.requestRetain?.({
      appId: DEER_FLOW_APP_ID,
      active: true,
      reason: "deer-flow-open",
    });
    return () => {
      h.background?.requestRetain?.({
        appId: DEER_FLOW_APP_ID,
        active: false,
        reason: "deer-flow-open",
      });
    };
  }, []);

  useEffect(() => {
    const h = host();
    if (!h.guest?.mount || !guestHostRef.current) {
      setBooting(false);
      setError("宿主未提供 host.guest.mount（需升级 Agnx 并重新扫描子应用）");
      return;
    }
    let cancelled = false;
    const unmount = h.guest.mount({
      container: guestHostRef.current,
      ensureTool: DEER_FLOW_ENSURE_TOOL_REL,
      ensureArgs: ["--port", String(DEER_FLOW_DEFAULT_PORT)],
      // 首次挂载要走 uv/pnpm 依赖就绪后的冷启动：LangGraph + Gateway + Next dev
      timeoutMs: 600_000,
      surfaceReadyTimeoutMs: 180_000,
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
      },
    });
    return () => {
      cancelled = true;
      unmount?.();
    };
  }, []);

  const BrandPanel = host().ui?.BrandLogoLoaderPanel as
    | ComponentType<WorkspaceAppBrandLogoLoaderPanelProps>
    | undefined;

  return (
    <div
      style={WEB_ROOT_STYLE}
      data-testid={`workspace-mini-app-${DEER_FLOW_APP_ID}-root`}
    >
      <div
        ref={guestHostRef}
        data-agnx-guest-surface-host="true"
        style={GUEST_HOST_STYLE}
      />
      {booting && !error && BrandPanel ? (
        <div
          data-agnx-guest-boot-overlay="true"
          style={LAYER}
          role="status"
        >
          <BrandPanel title="正在启动 DeerFlow…" testID="deer-flow-boot-overlay" />
        </div>
      ) : null}
      {error ? (
        <div style={LAYER} role="alert" data-deer-flow-error="1">
          <div style={ERROR_TEXT_STYLE}>{error}</div>
        </div>
      ) : null}
    </div>
  );
}
