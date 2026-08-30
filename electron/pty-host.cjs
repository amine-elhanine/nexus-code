// Out-of-process PTY host. Native PTY bindings are compiled against system
// Node's ABI and cannot be loaded inside the Electron main process, so this
// helper runs under the system Node and exposes terminals over a JSON-lines
// stdio protocol: one request object per line in, one event object per line
// out. If the host cannot start or node-pty is unavailable, terminal-service
// falls back to plain piped stdio.
const path = require("node:path");
const readline = require("node:readline");

function loadPty() {
  const candidates = [
    "node-pty",
    "@homebridge/node-pty-prebuilt-multiarch",
    path.join(__dirname, "..", "node_modules", "node-pty"),
    path.join(__dirname, "..", "node_modules", "@homebridge", "node-pty-prebuilt-multiarch"),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // try next candidate
    }
  }
  throw new Error("Neither node-pty nor @homebridge/node-pty-prebuilt-multiarch could be loaded.");
}

const send = (obj) => { try { process.stdout.write(JSON.stringify(obj) + "\n"); } catch { /* parent gone */ } };

let pty;
try {
  pty = loadPty();
} catch (error) {
  send({ ev: "fatal", message: `node-pty unavailable: ${error.message}` });
  process.exit(1);
}

const sessions = new Map();

function defaultShell() {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoLogo"] };
  return { file: process.env.SHELL || "bash", args: [] };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    if (msg.op === "spawn") {
      const shell = msg.shell ? { file: msg.shell, args: msg.args || [] } : defaultShell();
      const proc = pty.spawn(shell.file, shell.args, {
        name: "xterm-256color",
        cols: msg.cols || 80,
        rows: msg.rows || 24,
        cwd: msg.cwd || process.cwd(),
        env: Object.assign({}, process.env, { TERM: "xterm-256color", COLORTERM: "truecolor" }),
      });
      sessions.set(msg.id, proc);
      proc.onData((data) => send({ ev: "data", id: msg.id, data }));
      proc.onExit(({ exitCode }) => { sessions.delete(msg.id); send({ ev: "exit", id: msg.id, code: exitCode }); });
      send({ ev: "spawned", id: msg.id });
    } else if (msg.op === "write") {
      const proc = sessions.get(msg.id);
      if (proc) proc.write(msg.data);
    } else if (msg.op === "resize") {
      const proc = sessions.get(msg.id);
      if (proc) proc.resize(msg.cols, msg.rows);
    } else if (msg.op === "kill") {
      const proc = sessions.get(msg.id);
      if (proc) { sessions.delete(msg.id); proc.kill(); }
    }
  } catch (error) {
    send({ ev: "error", id: msg.id, message: error instanceof Error ? error.message : String(error) });
  }
});

// Parent death (stdin close) must tear down every terminal this host owns.
rl.on("close", () => {
  for (const proc of sessions.values()) { try { proc.kill(); } catch { /* already dead */ } }
  process.exit(0);
});

send({ ev: "ready", platform: process.platform });
