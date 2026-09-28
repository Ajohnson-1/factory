/**
 * End-to-end check of the Option A channel with no mocks on either side:
 * the real host IPC server (src/agents/ipc.ts) and the real extension baked into
 * the agent image (/opt/factory/extensions/spawn-agent.ts), driven by a model.
 *
 * Opt-in. Needs Docker + a reachable model. Not part of `npm test`.
 */
import { spawn } from "node:child_process";
import { createIpcServer, createIpcToken, IPC_PROTOCOL_VERSION } from "../src/agents/ipc.js";
import { IPC_ENV } from "../src/agents/spawn.js";
import { buildOrchestratorEnv } from "../src/agents/graph.js";
import { ROLES, spawnableRoleIds } from "../src/agents/roles.js";

const IMAGE = process.env.AGENT_IMAGE || "factory-agent";
const MODEL = process.env.AGENT_MODEL || "";
const PROVIDER = process.env.AGENT_PROVIDER || "";
const MODELS_FILE = process.env.FACTORY_AGENT_MODELS_FILE || "";
if (!MODELS_FILE) throw new Error("set FACTORY_AGENT_MODELS_FILE to a pi models.json");

const token = createIpcToken();
let spawnCalls = 0;
const server = await createIpcServer({
  token,
  host: "127.0.0.1",
  port: 0,
  onSpawn: async (request) => {
    spawnCalls += 1;
    console.log(`[host] spawn request ${spawnCalls}: role=${request.role} task=${request.task.slice(0, 60)}`);
    return {
      status: "ok",
      summary:
        `role=${request.role} run=c${spawnCalls} status=ok\n` +
        `landing: merged into the card branch as deadbeef\n` +
        `changed: src/${request.role.replace(/[^a-z]/g, "")}.js\n` +
        `diff --stat:\n src/x.js | 3 +++\n 1 file changed`,
    };
  },
});

const env = buildOrchestratorEnv({
  token,
  port: server.port,
  childTimeoutMs: 120_000,
  activeTools: ROLES.orchestrator.activeTools,
});

console.log(`[host] listening on 127.0.0.1:${server.port}`);
console.log(`[host] active tools -> ${env[IPC_ENV.activeTools]}`);

const args = [
  "run",
  "--rm",
  "-v",
  `${process.cwd()}/work:/work`,
  "-v",
  `${MODELS_FILE}:/home/agent/.pi/agent/models.json:ro`,
  "--add-host=host.docker.internal:host-gateway",
  "-e",
  `${IPC_ENV.host}=host.docker.internal`,
  "-e",
  `${IPC_ENV.port}=${env[IPC_ENV.port]}`,
  "-e",
  `${IPC_ENV.token}=${token}`,
  "-e",
  `${IPC_ENV.spawnTimeout}=${env[IPC_ENV.spawnTimeout]}`,
  "-e",
  `${IPC_ENV.activeTools}=${env[IPC_ENV.activeTools]}`,
  "-e",
  `${IPC_ENV.spawnable}=${env[IPC_ENV.spawnable]}`,
  "-w",
  "/work",
  "--user",
  `${process.getuid?.()}:${process.getgid?.()}`,
  IMAGE,
  "--mode",
  "json",
  "--no-approve",
  "--system-prompt",
  ROLES.orchestrator.systemPrompt,
  ...(MODEL ? ["--model", MODEL] : []),
  ...(PROVIDER ? ["--provider", PROVIDER] : []),
  "-e",
  "/opt/factory/extensions/spawn-agent.ts",
  "--",
  `You are the orchestrator. Call the spawn_agent tool twice IN ONE MESSAGE: ` +
    `first role="coder" task="add a greet() function", then role="coder" task="add a farewell() function". ` +
    `After both return, reply with the single word DONE.`,
];

const child = spawn("docker", args, { stdio: ["ignore", "pipe", "inherit"] });
let toolCalls: string[] = [];
let buffer = Buffer.alloc(0);
child.stdout.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  let nl = buffer.indexOf(0x0a);
  while (nl !== -1) {
    const line = buffer.subarray(0, nl).toString("utf8");
    buffer = buffer.subarray(nl + 1);
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type === "tool_execution_start") {
        toolCalls.push(String(record.toolName));
        console.log(`[pi] tool: ${record.toolName}`);
      }
      if (record.type === "message_end" && record.message) {
        const message = record.message as { role?: string; content?: unknown };
        if (message.role === "assistant" && Array.isArray(message.content)) {
          for (const block of message.content as Array<Record<string, string>>) {
            if (block.type === "text" && block.text.trim()) console.log(`[pi] text: ${block.text.slice(0, 200)}`);
          }
        }
      }
    } catch {
      /* not JSON */
    }
    nl = buffer.indexOf(0x0a);
  }
});
const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
await server.close();

console.log(`\n=== result ===`);
console.log(`docker exit: ${code}`);
console.log(`tool calls : ${JSON.stringify(toolCalls)}`);
console.log(`host spawns: ${spawnCalls} (protocol v${IPC_PROTOCOL_VERSION}, roles ${spawnableRoleIds().join("/")})`);
const pass = spawnCalls >= 2 && toolCalls.filter((t) => t === "spawn_agent").length >= 2;
console.log(pass ? "PASS: the extension reached the host twice" : "FAIL: no full round-trip");
process.exit(pass ? 0 : 1);
