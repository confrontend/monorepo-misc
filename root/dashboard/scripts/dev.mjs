import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const dashboardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pythonApiRoot = resolve(dashboardRoot, "..", "..", "python-api");

const wslPython = resolve(pythonApiRoot, "venv", "bin", "python");
const windowsPython = resolve(pythonApiRoot, "venv", "Scripts", "python.exe");

if (process.platform === "win32" && existsSync(wslPython) && !existsSync(windowsPython)) {
  console.error(
    "The existing Python environment is WSL/Linux. Run `npm run dev` from the WSL terminal, or recreate python-api/venv with Windows Python.",
  );
  process.exit(1);
}

const pythonCandidates =
  process.platform === "win32"
    ? [windowsPython, "python"]
    : [wslPython, "python3", "python"];

const python = pythonCandidates.find((candidate) =>
  candidate.includes("/") || candidate.includes("\\")
    ? existsSync(candidate)
    : true,
);

if (!python) {
  console.error(
    "Could not find Python. Create python-api/venv or install Python 3.11+.",
  );
  process.exit(1);
}

const children = [];

function start(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
    shell: process.platform === "win32" && command === "npm.cmd",
  });

  children.push(child);
  child.on("exit", (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`${command} exited with ${signal || `code ${code}`}`);
      shutdown(code || 1);
    }
  });

  return child;
}

let shuttingDown = false;

function killChild(child) {
  if (!child.pid) return;

  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  children.forEach(killChild);
  setTimeout(() => process.exit(code), 250);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("Starting Next.js and the Python API...");
start(python, ["-m", "uvicorn", "main:app", "--reload", "--host", "0.0.0.0", "--port", "8000"], pythonApiRoot);
start(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev:next"], dashboardRoot);
