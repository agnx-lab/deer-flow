// DeerFlow 子应用入口：注册一个面板（= 一类 Tab）+ 一个命令（侧栏按钮组 / 命令面板入口）。
import type { WorkspaceAppHostApi, WorkspaceAppModule } from "@agnx-lab/app-sdk";

import {
  DEER_FLOW_APP_ID,
  DEER_FLOW_DEFAULT_ENTITY_ID,
  DEER_FLOW_OPEN_COMMAND_ID,
  DEER_FLOW_PANEL_ID,
} from "./constants";
import { bindDeerFlowHost, DeerFlowPanel } from "./panel";

export const appId = DEER_FLOW_APP_ID;

export function activate(host: WorkspaceAppHostApi): () => void {
  bindDeerFlowHost(host);

  const disposers: Array<() => void> = [];

  // ① 面板：上游 DeerFlow 工作台（单 origin 8122，经 sidecar 反代）
  disposers.push(
    host.registerMiniApp({
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
      iframeShortcutCapture: true,
    }),
  );

  // ② 命令 → 打开 Tab
  disposers.push(
    host.registerCommand({
      id: DEER_FLOW_OPEN_COMMAND_ID,
      appId: DEER_FLOW_APP_ID,
      title: "DeerFlow",
      keywords: ["deerflow", "deer", "research", "superagent", "深度研究"],
      sidebarAction: {
        defaultVisible: true,
        label: "DeerFlow",
        order: 60,
      },
      run: (context) => {
        host.openSubAppTab({
          appId: DEER_FLOW_APP_ID,
          panelId: DEER_FLOW_PANEL_ID,
          entityId: DEER_FLOW_DEFAULT_ENTITY_ID,
          serverId: context?.serverId,
          workspaceId: context?.workspaceId,
          currentPathname: context?.currentPathname,
        });
      },
    }),
  );

  return () => {
    for (const dispose of disposers.toReversed()) dispose();
  };
}

const moduleExport: WorkspaceAppModule = { appId: DEER_FLOW_APP_ID, activate };
export default moduleExport;
