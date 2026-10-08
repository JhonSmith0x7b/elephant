import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [command = "dev", ...args] = process.argv.slice(2);
if (!["dev", "start"].includes(command)) throw new Error("只支持 dev 或 start。");

const children = [];
let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  // Do not leave a hidden background worker behind when the web app stops.
  const timeout = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);
  timeout.unref();
}

function launch(name, argv, env) {
  const child = spawn(process.execPath, argv, { cwd: root, env, stdio: "inherit" });
  children.push(child);
  child.on("error", () => {
    console.error(`${name}启动失败。`);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`${name}已停止，同步结束其他进程。`);
    stop(code ?? (signal ? 1 : 0));
  });
}

const env = { ...process.env, NODE_ENV: command === "dev" ? "development" : "production" };
launch("网页服务", ["node_modules/next/dist/bin/next", command, "--hostname", "127.0.0.1", ...args], env);
launch("后台同步", ["--env-file-if-exists=.env.local", "--import", "tsx", "scripts/sync-worker.ts"], env);
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
