// DeerFlow 进程树管理器（Agnx 子应用胶水层）
//
// 上游 `make dev` 会起 4 个进程（langgraph :2024 / gateway :8001 / next :3026 / nginx :2026），
// 而 nginx 那一层绑 2026、且会 pkill 全局 next/nginx。Agnx 里我们要：
//   · 只暴露一个 origin 8122（由 .agnx/tools/proxy.mjs 承担反代，替代 nginx）；
//   · 子进程归本 app 自己管，退出时整树回收，绝不 pkill 别的 app 的进程；
//   · 所有可变数据落 apps/data/deer-flow。
//
// 用法：node supervisor.mjs --port 8122 --data-root <dir> --root <appDir> [--frontend-port 3026]

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const PORT = Number(argOf("port", "8122"));
const APP_ROOT = path.resolve(argOf("root", "."));
const DATA_ROOT = path.resolve(argOf("data-root", path.join(APP_ROOT, "..", "data", "deer-flow")));
const UPSTREAM = path.join(APP_ROOT, "upstream");
const LOG_DIR = path.join(APP_ROOT, "logs");
const FRONTEND_PORT = Number(argOf("frontend-port", "3026"));
const GATEWAY_PORT = Number(argOf("gateway-port", "8001"));
const LANGGRAPH_PORT = Number(argOf("langgraph-port", "2024"));
// 落地页：上游根路径是营销官网，小屏下被整页缩放；嵌入默认落到工作台（与 nginx 方案同一份前端，仅换入口路径）
const FRONTEND_PATH = argOf("frontend-path", "/workspace/chats/new");

const ENV_FILE = path.join(DATA_ROOT, ".env");
const CONFIG_FILE = path.join(DATA_ROOT, "config.yaml");
const EXT_FILE = path.join(DATA_ROOT, "extensions_config.json");
const DATA_DIR = path.join(DATA_ROOT, "data");

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });

// pid 文件：既供回收脚本精确 kill（不 pkill），也避免多开
const PID_FILE = path.join(DATA_ROOT, "supervisor.pid");
try {
  writeFileSync(PID_FILE, String(process.pid));
} catch {
  /* ignore */
}

function log(text) {
  const line = `[${new Date().toISOString()}] ${text}\n`;
  process.stdout.write(line);
  try {
    appendFileSync(path.join(LOG_DIR, "supervisor.log"), line);
  } catch {
    /* ignore */
  }
}

/** 读取 apps/data/deer-flow/.env（KEY=VALUE，# 注释），密钥不落代码。 */
function readDotEnv() {
  const env = {};
  if (!existsSync(ENV_FILE)) return env;
  for (const raw of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const baseEnv = {
  ...process.env,
  ...readDotEnv(),
  // 数据根：上游 Paths / checkpointer / memory 全部跟随 DEER_FLOW_HOME
  DEER_FLOW_HOME: DATA_DIR,
  DEER_FLOW_CONFIG_PATH: CONFIG_FILE,
  DEER_FLOW_EXTENSIONS_CONFIG_PATH: EXT_FILE,
  NO_COLOR: "1",
  PYTHONUNBUFFERED: "1",
  // LangGraph 与前端都跑在同一个 loopback 上，显式给出端口避免撞已装 app
  LANGGRAPH_PORT: String(LANGGRAPH_PORT),
};

const children = [];
let shuttingDown = false;

function spawnLogged(name, command, cmdArgs, cwd, extraEnv = {}) {
  const out = openSync(path.join(LOG_DIR, `${name}.log`), "a");
  const child = spawn(command, cmdArgs, {
    cwd,
    env: { ...baseEnv, ...extraEnv },
    stdio: ["ignore", out, out],
    detached: false,
  });
  child.__name = name;
  children.push(child);
  log(`spawn ${name} pid=${child.pid} cwd=${cwd}`);
  child.on("exit", (code, signal) => {
    log(`${name} exited code=${code} signal=${signal}`);
    if (!shuttingDown && name !== "proxy") {
      // 关键子进程挂了就整树收掉，避免"半死不活"占着端口
      log(`${name} 非正常退出，回收整棵树`);
      shutdown(1);
    }
  });
  return child;
}

function probe(port, pathname = "/", timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: pathname, timeout: timeoutMs, headers: { "accept-encoding": "identity" } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.on("error", () => resolve(0));
  });
}

async function waitFor(name, port, pathname, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (shuttingDown) throw new Error("shutting down");
    const code = await probe(port, pathname);
    if (code > 0 && code < 500) {
      log(`${name} ready on :${port} (${code}) in ${Math.round((Date.now() - start) / 1000)}s`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} 未在 ${Math.round(deadlineMs / 1000)}s 内就绪（:${port}${pathname}）`);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutdown: 回收 ${children.length} 个子进程`);
  for (const child of children) {
    try {
      if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => {
    for (const child of children) {
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    sweepStrayListeners();
    process.exit(code);
  }, 4000);
}

/**
 * 兜底回收：langgraph cli / next dev 都会派生孙子进程，supervisor 直接收到 SIGTERM 时
 * 它们可能变成孤儿继续占着 2024/8001/3026。这里**只**处理监听本 app 三个端口的进程，
 * 逐个核对命令行里带本 app 的 upstream 路径才杀——绝不 pkill 同名进程去打扰别的 app。
 */
function sweepStrayListeners() {
  for (const port of [LANGGRAPH_PORT, GATEWAY_PORT, FRONTEND_PORT]) {
    let out = "";
    try {
      out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    } catch {
      continue;
    }
    for (const pid of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (Number(pid) === process.pid) continue;
      let cmd = "";
      try {
        cmd = execFileSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" });
      } catch {
        continue;
      }
      if (!cmd.includes(APP_ROOT) && !cmd.includes(UPSTREAM)) {
        // next dev 会派生 `next-server`，命令行里没有路径：看父进程是不是我们的孩子
        const parentText = readProcParent(pid);
        if (!parentText.includes(UPSTREAM) && !parentText.includes(APP_ROOT)) {
          log(`跳过 :${port} 上非本 app 的进程 pid=${pid}`);
          continue;
        }
      }
      try {
        process.kill(Number(pid), "SIGKILL");
        log(`回收残留监听进程 :${port} pid=${pid}`);
      } catch {
        /* ignore */
      }
    }
  }
}


for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => shutdown(0));
}

function tail(file, lines = 15) {
  if (!existsSync(file)) return "(no log)";
  const text = readFileSync(file, "utf8").trimEnd().split("\n");
  return text.slice(-lines).join("\n");
}

function fail(what, file) {
  log(`${what}\n${tail(file)}`);
  shutdown(1);
}

async function main() {
  log(`---- deer-flow supervisor start (origin :${PORT}) dataRoot=${DATA_ROOT}`);

  // 0) 配置就绪（DeerFlow 无 config.yaml 直接拒启）：缺了就用示例模板 + 本机可用密钥生成
  if (!existsSync(CONFIG_FILE)) {
    log(`缺少 ${CONFIG_FILE}，自动生成…`);
    const gen = spawn(process.execPath, [path.join(APP_ROOT, ".agnx", "tools", "gen-config.mjs"), "--data-root", DATA_ROOT], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    await new Promise((resolve) => gen.on("exit", resolve));
  }
  if (!existsSync(CONFIG_FILE)) {
    log(`配置生成失败：${CONFIG_FILE}`, );
    process.exit(2);
  }

  const py = path.join(UPSTREAM, "backend", ".venv", "bin", "python");
  const backendDir = path.join(UPSTREAM, "backend");
  const frontendDir = path.join(UPSTREAM, "frontend");
  if (!existsSync(py)) {
    log(`后端虚拟环境缺失：${py}（需先 cd upstream/backend && uv sync --python 3.12）`);
    process.exit(3);
  }
  if (!existsSync(path.join(frontendDir, "node_modules"))) {
    log(`前端依赖缺失：${frontendDir}/node_modules（需先 pnpm install）`);
    process.exit(3);
  }

  // 1) 端口守卫：8001 / 2024 若被别的 app 占着就别硬抢
  for (const [name, port] of [
    ["gateway", GATEWAY_PORT],
    ["langgraph", LANGGRAPH_PORT],
    ["frontend", FRONTEND_PORT],
  ]) {
    const code = await probe(port, "/", 800);
    if (code > 0) {
      log(`端口 ${port}（${name}）已被占用，拒绝启动以免打断其它服务`);
      process.exit(4);
    }
  }

  // 2) LangGraph server（:2024）
  spawnLogged(
    "langgraph",
    py,
    ["-m", "langgraph_cli", "dev", "--no-browser", "--allow-blocking", "--port", String(LANGGRAPH_PORT), "--host", "127.0.0.1"],
    backendDir,
    { PYTHONPATH: "." },
  );
  try {
    await waitFor("langgraph", LANGGRAPH_PORT, "/ok", 180_000);
  } catch (e) {
    fail(String(e), path.join(LOG_DIR, "langgraph.log"));
    return;
  }

  // 3) Gateway API（:8001）
  spawnLogged(
    "gateway",
    py,
    ["-m", "uvicorn", "app.gateway.app:app", "--host", "127.0.0.1", "--port", String(GATEWAY_PORT)],
    backendDir,
    { PYTHONPATH: "." },
  );
  try {
    await waitFor("gateway", GATEWAY_PORT, "/health", 180_000);
  } catch (e) {
    fail(String(e), path.join(LOG_DIR, "gateway.log"));
    return;
  }

  // 4) Next.js 前端（:3026）
  spawnLogged(
    "frontend",
    process.execPath,
    [path.join(frontendDir, "node_modules", "next", "dist", "bin", "next"), "dev", "--turbo", "--port", String(FRONTEND_PORT), "--hostname", "127.0.0.1"],
    frontendDir,
    {
      NODE_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      // 前端 → 后端同源：所有 /api 走 8122 反代，因此不设 NEXT_PUBLIC_*_BASE_URL
      BETTER_AUTH_SECRET: baseEnv.BETTER_AUTH_SECRET || "deer-flow-agnx-local-dev-secret",
    },
  );
  try {
    await waitFor("frontend", FRONTEND_PORT, FRONTEND_PATH, 300_000);
  } catch (e) {
    fail(String(e), path.join(LOG_DIR, "frontend.log"));
    return;
  }

  // 5) 单 origin 反代（:8122）
  spawnLogged(
    "proxy",
    process.execPath,
    [
      path.join(APP_ROOT, ".agnx", "tools", "proxy.mjs"),
      "--port",
      String(PORT),
      "--frontend",
      String(FRONTEND_PORT),
      "--gateway",
      String(GATEWAY_PORT),
      "--langgraph",
      String(LANGGRAPH_PORT),
      "--frontend-path",
      FRONTEND_PATH,
      "--log-dir",
      LOG_DIR,
    ],
    APP_ROOT,
  );
  try {
    await waitFor("proxy", PORT, "/health", 30_000);
  } catch (e) {
    fail(String(e), path.join(LOG_DIR, "proxy.log"));
    return;
  }

  log(`deer-flow ready at http://127.0.0.1:${PORT}`);
  // 常驻：由 Agnx sidecar supervisor 管生命周期
  setInterval(() => undefined, 1 << 30);
}

main().catch((err) => {
  log(`fatal: ${err?.stack || err}`);
  shutdown(1);
});
