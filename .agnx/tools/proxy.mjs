// DeerFlow 单 origin 反代（Agnx 子应用胶水层）
//
// 为什么需要它：上游把前端（Next.js :3026）、网关（FastAPI :8001）、LangGraph（:2024）
// 拆成三个端口，再用 nginx :2026 合流。Agnx 对子应用只暴露一个 origin（:8122），
// 所以这里起一个「无第三方依赖」的 Node 反代，按上游 `docker/nginx/nginx.local.conf`
// 的路由表把三者合到 8122 一个口上。**不改上游任何业务代码**，路由规则与 nginx 一致：
//
//   /api/langgraph/*  → 127.0.0.1:2024/*        （SSE 流式，需关闭缓冲）
//   /api/*            → 127.0.0.1:8001/api/*    （gateway，含 /api/threads、/api/models…）
//   /health /docs …   → 127.0.0.1:8001/*
//   其余               → 127.0.0.1:3026         （Next.js，含 WS upgrade）
//
// 用法：node proxy.mjs --port 8122 --frontend 3026 --gateway 8001 --langgraph 2024

import http from "node:http";
import net from "node:net";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const PORT = Number(argOf("port", "8122"));
const FRONTEND_PORT = Number(argOf("frontend", "3026"));
const GATEWAY_PORT = Number(argOf("gateway", "8001"));
const LANGGRAPH_PORT = Number(argOf("langgraph", "2024"));
// 根路径重定向到上游工作台（上游 / 是营销落地页，不适合当工作台入口）
const FRONTEND_PATH = argOf("frontend-path", "/workspace/chats/new");
const LOG_DIR = argOf("log-dir", "");

const GATEWAY_PREFIXES = ["/api", "/docs", "/redoc", "/openapi.json", "/health"];

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(text);
  if (LOG_DIR) {
    try {
      appendFileSync(`${LOG_DIR}/proxy.log`, text);
    } catch {
      /* 日志失败不影响服务 */
    }
  }
}

/** 按上游 nginx 路由表决定上游端口与改写后的路径。 */
function route(rawUrl) {
  const q = rawUrl.indexOf("?");
  const pathname = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
  const search = q >= 0 ? rawUrl.slice(q) : "";

  if (pathname === "/api/langgraph" || pathname.startsWith("/api/langgraph/")) {
    const rest = pathname.slice("/api/langgraph".length) || "/";
    return { port: LANGGRAPH_PORT, path: rest + search, kind: "langgraph" };
  }
  for (const prefix of GATEWAY_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return { port: GATEWAY_PORT, path: rawUrl, kind: "gateway" };
    }
  }
  if (pathname === "/") {
    return { port: FRONTEND_PORT, path: FRONTEND_PATH + search, kind: "frontend" };
  }
  return { port: FRONTEND_PORT, path: rawUrl, kind: "frontend" };
}

const server = http.createServer((req, res) => {
  const target = route(req.url || "/");
  const headers = { ...req.headers };

  // 反代必须做的三件事：去掉 Origin（上游 CORS 由自己判断）、Host 改上游、
  // 禁用压缩协商（避免 chunked/压缩流在中间层被缓冲，LangGraph SSE 会卡住）。
  delete headers.origin;
  delete headers.referer;
  headers.host = `127.0.0.1:${target.port}`;
  headers["accept-encoding"] = "identity";
  // 让 Next.js 知道外部访问的是 127.0.0.1:8122
  headers["x-forwarded-host"] = `127.0.0.1:${PORT}`;
  headers["x-forwarded-proto"] = "http";

  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: target.port,
      method: req.method,
      path: target.path,
      headers,
    },
    (up) => {
      const outHeaders = { ...up.headers };
      // 禁止上游把「不许被嵌」的头带给浏览器，否则 Agnx 的 iframe 直接白屏。
      delete outHeaders["x-frame-options"];
      if (outHeaders["content-security-policy"]) {
        outHeaders["content-security-policy"] = String(outHeaders["content-security-policy"])
          .split(";")
          .filter((d) => !d.trim().toLowerCase().startsWith("frame-ancestors"))
          .join(";");
      }
      res.writeHead(up.statusCode || 502, outHeaders);
      up.pipe(res);
    },
  );

  upstream.on("error", (err) => {
    log(`upstream ${target.kind} ${target.port} error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(`DeerFlow 上游 ${target.kind} (:${target.port}) 不可达：${err.message}`);
  });

  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
});

// Next.js dev/HMR 走 WebSocket，必须做 upgrade 转发，否则页面能开但热更新断流、报错。
server.on("upgrade", (req, socket, head) => {
  const target = route(req.url || "/");
  const up = net.connect(target.port, "127.0.0.1", () => {
    const lines = [`${req.method} ${target.path} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = req.rawHeaders[i + 1];
      if (name.toLowerCase() === "origin" || name.toLowerCase() === "host") continue;
      lines.push(`${name}: ${value}`);
    }
    lines.push(`Host: 127.0.0.1:${target.port}`, "", "");
    up.write(lines.join("\r\n"));
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", (err) => {
    log(`upgrade ${target.kind} error: ${err.message}`);
    socket.destroy();
  });
  socket.on("error", () => up.destroy());
});

server.listen(PORT, "127.0.0.1", () => {
  log(
    `deer-flow proxy listening on http://127.0.0.1:${PORT} -> frontend:${FRONTEND_PORT} gateway:${GATEWAY_PORT} langgraph:${LANGGRAPH_PORT}`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
