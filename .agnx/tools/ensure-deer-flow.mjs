#!/usr/bin/env node
// DeerFlow sidecar ensure（Agnx 子应用胶水层，supervised 模式）
//
// protocol：`--supervised` 时只打印启动 plan（宿主 daemon supervisor 负责 spawn / pid / 日志 / 退出清理）；
// 否则自己 spawn 并等待就绪后输出 origin（供手工调试）。
//
// 输出（最后一行）：{"ok":true,"plan":{command,args,cwd,env,fingerprint,healthUrl,port}}
//   复用已就绪服务：{"ok":true,"reused":true,"origin":"http://127.0.0.1:8122","pid":...}
//   失败：           {"ok":false,"error":"..."}

import http from "node:http";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "../..");

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const supervised = args.includes("--supervised");
const port = Number(argOf("port", "8122"));
const workDir = argOf("work-dir", process.env.AGNX_APP_DATA_ROOT || "");
const dataRoot = path.resolve(argOf("data-root", workDir || path.join(appRoot, "..", "data", "deer-flow")));
const origin = `http://127.0.0.1:${port}`;

function emit(obj) {
  // 宿主侧栏绿点严格绑 PID（见 app 的 projectWorkspaceAppRuntimeStatus）：
  // 它读 $AGNX_HOME/apps/data/<appId>/<stateFile> 里的 pid，没有该文件就判 off。
  // 之前本脚本从不写它，导致 DeerFlow 服务在跑、侧栏却始终没有绿点。
  if (obj && obj.ok) {
    try {
      const statePath = path.join(dataRoot, "deer-flow.json");
      mkdirSync(path.dirname(statePath), { recursive: true });
      writeFileSync(
        statePath,
        JSON.stringify(
          {
            appId: "deer-flow",
            port: obj.port ?? port,
            pid: obj.pid ?? readSupervisorPid() ?? null,
            origin: obj.origin ?? origin,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // 写状态失败不影响服务本身。
    }
  }
  console.log(JSON.stringify(obj));
}

/** supervisor.pid 是 supervisor 自己写的；ensure 复用时用它回填 pid。 */
function readSupervisorPid() {
  try {
    const raw = readFileSync(path.join(dataRoot, "supervisor.pid"), "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function probe(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/health", timeout: timeoutMs, headers: { "accept-encoding": "identity" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "" });
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
  });
}

async function main() {
  // 1) 已就绪 → 复用（关 Tab 再开不该重复起服务）
  const hit = await probe();
  if (hit.status >= 200 && hit.status < 500 && hit.body.includes("deer-flow-gateway")) {
    emit({ ok: true, reused: true, origin, port });
    return;
  }
  if (hit.status > 0) {
    emit({ ok: false, error: `PORT_IN_USE: :${port} 已被非 DeerFlow 服务占用（HTTP ${hit.status}）` });
    return;
  }

  // 2) 依赖守卫：缺 python venv / node_modules 时给出人话
  const py = path.join(appRoot, "upstream", "backend", ".venv", "bin", "python");
  if (!existsSync(py)) {
    emit({ ok: false, error: `BACKEND_DEPS_MISSING: ${py} 不存在，请先 (cd ${appRoot}/upstream/backend && uv sync --python 3.12)` });
    return;
  }
  if (!existsSync(path.join(appRoot, "upstream", "frontend", "node_modules"))) {
    emit({ ok: false, error: `FRONTEND_DEPS_MISSING: upstream/frontend/node_modules 不存在，请先 pnpm install` });
    return;
  }
  if (!existsSync(path.join(dataRoot, "config.yaml"))) {
    // 首次运行：由 config.example.yaml 生成，模型按本机可用密钥决定（无密钥则占位配置，主界面仍可开）
    const { spawnSync } = await import("node:child_process");
    spawnSync(process.execPath, [path.join(appRoot, ".agnx", "tools", "gen-config.mjs"), "--data-root", dataRoot], {
      stdio: "ignore",
    });
  }
  if (!existsSync(path.join(dataRoot, "config.yaml"))) {
    emit({ ok: false, error: `CONFIG_MISSING: ${dataRoot}/config.yaml 不存在且自动生成失败` });
    return;
  }

  const plan = {
    command: process.execPath,
    args: [
      path.join(appRoot, ".agnx", "tools", "supervisor.mjs"),
      "--port",
      String(port),
      "--root",
      appRoot,
      "--data-root",
      dataRoot,
    ],
    cwd: appRoot,
    env: {
      AGNX_APP_DATA_ROOT: dataRoot,
      DEER_FLOW_HOME: path.join(dataRoot, "data"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    fingerprint: `deer-flow-${port}-${dataRoot}`,
    healthUrl: `${origin}/health`,
    port,
  };

  if (supervised) {
    emit({ ok: true, reused: false, plan });
    return;
  }

  // 3) 非 supervised：自己拉起来并等就绪（手工调试用）
  const { spawn } = await import("node:child_process");
  const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: { ...process.env, ...plan.env }, stdio: "inherit", detached: true });
  child.unref();
  const start = Date.now();
  while (Date.now() - start < 600_000) {
    const r = await probe();
    if (r.status >= 200 && r.status < 500 && r.body.includes("deer-flow-gateway")) {
      emit({ ok: true, reused: false, origin, port, pid: child.pid });
      return;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  emit({ ok: false, error: "START_TIMEOUT: 10 分钟内未就绪，见 logs/supervisor.log" });
}

main().catch((err) => {
  emit({ ok: false, error: `ENSURE_EXCEPTION: ${err?.message || err}` });
  process.exit(1);
});
