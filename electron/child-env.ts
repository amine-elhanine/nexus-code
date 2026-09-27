// Child processes must not inherit host secrets. Daemons use a structural
// allowlist (dev servers need almost nothing — see daemon-service.ts);
// interactive terminals keep the full user environment minus secret-shaped
// variables so user tooling still works but API keys never reach a shell.

const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|api[_-]?token|token|secret|password|passwd|private[_-]?key|access[_-]?key|client[_-]?id|credentials|bearer)/i;

export function scrubSecretEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_KEY_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return out;
}
