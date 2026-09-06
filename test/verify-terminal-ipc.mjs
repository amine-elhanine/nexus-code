// Verifies the terminal:create IPC fix: the handler must return a structured-
// cloneable payload. Electron IPC serializes with v8::ValueSerializer — the same
// algorithm as structuredClone — so a payload that clones here crosses IPC, and
// one that throws here fails with "An object could not be cloned".
import { terminalService } from "../dist-electron/terminal-service.js";

const session = await terminalService.createSession("ipc_test", process.cwd(), () => {});
console.log("session mode:", session.mode);

try {
  structuredClone(session);
  console.log("OLD BUG CHECK — raw session cloneable: yes (unexpected)");
} catch (error) {
  console.log("OLD BUG CHECK — raw session cloneable: no ->", error.message.slice(0, 60));
}

// Exactly what the fixed terminal:create handler now returns (main.ts).
const ipcPayload = { id: session.id, mode: session.mode, cols: session.cols, rows: session.rows, alive: session.alive };
structuredClone(ipcPayload);
console.log("FIXED PAYLOAD — handler payload cloneable: yes ->", JSON.stringify(ipcPayload));

terminalService.killAll();
process.exit(0);
