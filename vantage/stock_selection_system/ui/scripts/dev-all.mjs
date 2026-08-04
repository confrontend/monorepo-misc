#!/usr/bin/env node
// Runs the FastAPI backend and the Vite dev server together from a single
// `npm run dev:all` (see package.json). Deliberately zero extra npm
// dependencies (no `concurrently`) -- just Node's built-in child_process,
// spawning each binary directly (no shell wrapping) so process.kill() maps
// straight onto the real process with no subshell in between.
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(__dirname, "..");
const projectDir = path.resolve(uiDir, ".."); // stock_selection_system/

const isWin = process.platform === "win32";
const npmBin = isWin ? "npm.cmd" : "npm";

const PIP_INSTALL_HINT =
  `pip install -r requirements.txt` +
  ` (from ${path.relative(process.cwd(), projectDir) || "."}; add --break-system-packages if pip refuses with "externally-managed-environment")`;

// `uvicorn` the bare command only works if pip's script directory happens to
// be on PATH, which varies a lot by how it was installed (system pip,
// --user, a venv, pipx...). Running `python -m uvicorn` instead only
// requires the PYTHON interpreter to be findable -- the uvicorn package
// itself is then resolved via that interpreter's own site-packages, no PATH
// entry for the console script needed.
//
// Finding "the right python" is the tricky part. A `.venv` doesn't have to
// live inside stock_selection_system/ -- e.g. it can sit at a monorepo root
// several directories up, as it did for the setup this was written against
// (vantage/.venv, with stock_selection_system/ one level below). Even when a
// venv IS active in the shell that ran `npm run dev:all`, Node's spawn()
// resolves bare command names via its own PATH search, which can still miss
// the venv if its bin/ directory only provides a `python` binary and not a
// `python3` one -- so we don't just trust an unqualified "python3" lookup.
function venvPythonPath(venvDir) {
  return path.join(venvDir, isWin ? "Scripts\\python.exe" : "bin/python");
}

function findCandidateVenvs() {
  const found = [];
  // 1. An ACTIVE venv, if `npm run dev:all` was launched from an activated
  //    shell -- activation sets VIRTUAL_ENV and this is the most direct
  //    signal available, independent of where the venv physically lives.
  if (process.env.VIRTUAL_ENV) found.push(venvPythonPath(process.env.VIRTUAL_ENV));
  // 2. Walk upward from the project directory looking for a `.venv/`,
  //    covering both "venv inside stock_selection_system/" and "venv at a
  //    monorepo root above it."
  let dir = projectDir;
  for (let i = 0; i < 5; i++) {
    found.push(venvPythonPath(path.join(dir, ".venv")));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

function resolvePython() {
  const candidates = [...findCandidateVenvs(), "python3", "python"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-c", "import uvicorn"], { stdio: "ignore" });
    if (!result.error && result.status === 0) return { cmd: candidate, hasUvicorn: true };
  }
  // Fall back to the first candidate that at least exists as an
  // interpreter, so the resulting error message ("No module named
  // uvicorn") points at the real problem instead of "command not found."
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error) return { cmd: candidate, hasUvicorn: false };
  }
  return { cmd: isWin ? "python" : "python3", hasUvicorn: false };
}

const { cmd: pythonCmd, hasUvicorn } = resolvePython();
if (!hasUvicorn) {
  console.warn(
    `\x1b[33mWarning: uvicorn isn't importable via '${pythonCmd}'. The backend will likely fail to start.\x1b[0m\n` +
      `Run: ${PIP_INSTALL_HINT}\n`,
  );
}

const procs = [];

function run(name, color, command, args, cwd, exitHint, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(child);
  const startedAt = Date.now();

  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) out.write(prefix + line + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on("error", (err) => {
    process.stderr.write(`${prefix}failed to start '${command}': ${err.message}\n`);
    if (exitHint) process.stderr.write(`${prefix}${exitHint}\n`);
    shutdown();
  });

  child.on("exit", (code, signal) => {
    process.stdout.write(`${prefix}exited (${signal ?? code})\n`);
    // A near-instant non-zero exit (as opposed to Ctrl+C later) almost
    // always means "couldn't actually start" -- e.g. a missing dependency --
    // so surface the hint here too, not just on outright spawn failures.
    if (exitHint && code !== 0 && code !== null && Date.now() - startedAt < 5000) {
      process.stderr.write(`${prefix}${exitHint}\n`);
    }
    // If either side dies, bring the other down too rather than leaving an
    // orphaned dev server running silently in the background.
    shutdown();
  });

  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    if (!p.killed) p.kill();
  }
  setTimeout(() => process.exit(0), 300);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// cwd is the project root (not ui/), so api.main:app and the src/ package it
// imports resolve without needing --app-dir or any PATH/env trickery.
run(
  "BE", "32", pythonCmd,
  [
    "-m", "uvicorn", "api.main:app", "--reload", "--reload-dir", projectDir,
    "--reload-delay", "0.2", "--log-level", "debug", "--port", "8000",
  ],
  projectDir,
  `Run: ${PIP_INSTALL_HINT}`,
);
run(
  "FE", "36", npmBin,
  ["run", "dev", "--", "--host", "0.0.0.0", "--clearScreen", "false", "--logLevel", "info"],
  uiDir,
  "Run: npm install (from ui/)",
  { ...process.env, VITE_DEBUG: "true" },
);
run(
  "BUILD", "35", npmBin,
  ["run", "build:watch"],
  uiDir,
  "Run: npm install (from ui/)",
  { ...process.env, VITE_DEBUG: "true" },
);

console.log(`Backend:  http://localhost:8000  (docs at /docs)  [using ${pythonCmd}]`);
console.log("Frontend: http://localhost:5173  (Vite HMR enabled; browser changes update immediately)");
console.log("UI build: watching source files and rebuilding ui/dist");
console.log("Backend reload: watching the project directory for Python changes");
console.log("Press Ctrl+C to stop both.\n");
