#!/usr/bin/env node
// 由 config.example.yaml 生成「指针接入」的 config.yaml（Agnx 子应用胶水层）
//
// 为什么需要它：上游 AppConfig.resolve_env_variables 对 `$VAR` 是**严格解析**——
// 变量不存在就抛 ValueError 直接拒启。而 DeerFlow 的模型密钥在「没配密钥的机器」上必然缺失，
// 于是主界面都打不开。这里不放宽上游，而是：
//   · 有对应密钥 → 写该模型的声明（值仍写 `$VAR`，密钥只来自环境变量 / apps/data/deer-flow/.env）；
//   · 无任何可用密钥 → 写一组无 api_key 的占位模型（含 CLI 型 provider），
//     让网关/SDK 的「模型列表」接口照常返回，主界面与新任务页可用，真正发研究任务时才提示缺密钥。
//
// 产出：apps/data/deer-flow/config.yaml（数据根，不写进安装目录）；已有文件默认不覆盖，--force 重建。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "../..");
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const dataRoot = path.resolve(argOf("data-root", path.join(appRoot, "..", "data", "deer-flow")));
const force = args.includes("--force");
const target = path.join(dataRoot, "config.yaml");
const upstreamExample = path.join(appRoot, "upstream", "config.example.yaml");

function readDotEnv() {
  const env = {};
  const file = path.join(dataRoot, ".env");
  if (!fs.existsSync(file)) return env;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const dotenv = readDotEnv();
const has = (key) => Boolean(process.env[key] || dotenv[key]);

const candidates = [
  {
    key: "DEEPSEEK_API_KEY",
    yaml: `  - name: deepseek-chat
    display_name: DeepSeek Chat
    use: langchain_openai:ChatOpenAI
    model: deepseek-chat
    api_key: $DEEPSEEK_API_KEY
    base_url: https://api.deepseek.com/v1
    max_tokens: 8192
    temperature: 0.7
    supports_vision: false`,
  },
  {
    key: "VOLCENGINE_API_KEY",
    yaml: `  - name: doubao-seed
    display_name: Doubao Seed (Volcengine)
    use: deerflow.models.patched_deepseek:PatchedChatDeepSeek
    model: doubao-seed-code
    api_base: https://ark.cn-beijing.volces.com/api/v3
    api_key: $VOLCENGINE_API_KEY
    supports_thinking: true
    supports_vision: true
    when_thinking_enabled:
      extra_body:
        thinking:
          type: enabled`,
  },
  {
    key: "OPENAI_API_KEY",
    yaml: `  - name: gpt-4o-mini
    display_name: GPT-4o mini (OpenAI)
    use: langchain_openai:ChatOpenAI
    model: gpt-4o-mini
    api_key: $OPENAI_API_KEY
    max_tokens: 4096
    temperature: 0.7
    supports_vision: true`,
  },
  {
    key: "MOONSHOT_API_KEY",
    yaml: `  - name: kimi-k2.5
    display_name: Kimi K2.5 (Moonshot)
    use: deerflow.models.patched_deepseek:PatchedChatDeepSeek
    model: kimi-k2.5
    api_base: https://api.moonshot.cn/v1
    api_key: $MOONSHOT_API_KEY
    max_tokens: 32768
    supports_thinking: true
    supports_vision: true`,
  },
  {
    key: "OPENROUTER_API_KEY",
    yaml: `  - name: openrouter-gemini-2.5-flash
    display_name: Gemini 2.5 Flash (OpenRouter)
    use: langchain_openai:ChatOpenAI
    model: google/gemini-2.5-flash-preview
    api_key: $OPENROUTER_API_KEY
    base_url: https://openrouter.ai/api/v1
    max_tokens: 8192
    temperature: 0.7`,
  },
];

// 无密钥时的占位：不声明 api_key（LangChain/DeepSeek 客户端只在真正调用时才要求密钥），
// 但模型列表与非流式页面全部可用。CLI 型 provider 直接复用本机登录态（若存在）。
const placeholders = `  # —— 未检测到任何模型密钥：以下为占位声明，保证主界面 / 模型列表 / 新任务页可用 ——
  # 配好密钥后重启 sidecar（或在 apps/data/deer-flow/.env 写入 <PROVIDER>_API_KEY）即可换成真实模型。
  - name: deepseek-chat
    display_name: DeepSeek Chat（未配置密钥）
    use: langchain_openai:ChatOpenAI
    model: deepseek-chat
    base_url: https://api.deepseek.com/v1
    max_tokens: 8192
    temperature: 0.7
    supports_vision: false
  - name: claude-code
    display_name: Claude Sonnet 4.6 (Claude Code OAuth)
    use: deerflow.models.claude_provider:ClaudeChatModel
    model: claude-sonnet-4-6
    max_tokens: 4096
    supports_thinking: true`;

if (fs.existsSync(target) && !force) {
  console.log(JSON.stringify({ ok: true, action: "kept", path: target }));
  process.exit(0);
}

const enabled = candidates.filter((c) => has(c.key));
const modelsBlock =
  enabled.length > 0
    ? `models:\n${enabled.map((c) => c.yaml).join("\n")}\n`
    : `models:\n${placeholders}\n`;

let text = fs.readFileSync(upstreamExample, "utf8");
// 1) 用生成的模型段替换示例里的 models 段
text = text.replace(/^models:\n[\s\S]*?(?=^# =+\n# Tool Groups Configuration)/m, modelsBlock);
// 2) 数据落 apps/data/deer-flow/data
fs.mkdirSync(path.join(dataRoot, "data"), { recursive: true });
text = text.replace(
  /^checkpointer:\n  type: sqlite\n  connection_string: .*$/m,
  `checkpointer:\n  type: sqlite\n  connection_string: ${path.join(dataRoot, "data", "checkpoints.db")}`,
);
text = text.replace(/^  storage_path: .*$/m, `  storage_path: ${path.join(dataRoot, "data", "memory.json")}`);
text = text.replace(
  /^skills:\n([\s\S]*?)(?=^# =)/m,
  `skills:\n  path: ${path.join(appRoot, "upstream", "skills")}\n  container_path: /mnt/skills\n\n`,
);

fs.writeFileSync(target, text);
console.log(
  JSON.stringify({
    ok: true,
    action: fs.existsSync(target) ? "written" : "unknown",
    path: target,
    models: enabled.length > 0 ? enabled.map((c) => c.key) : ["placeholder"],
  }),
);
