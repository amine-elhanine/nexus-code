// Phase 5 ("one composer, three destinations"): renderer-side mode routing.
//
// The Home composer is the natural single input box — but repo-work requests
// ("fix the build", "why does this test fail") belong in Code mode, where the
// agent has the workspace, LSP, and verification tools. This conservative
// heuristic surfaces a non-blocking suggestion chip instead of auto-routing:
// the user keeps control, and false positives cost one glance, not a wrong
// agent. Notebook handoff already exists (onHandoffToCode); this covers the
// Home → Code direction.

const CODE_INTENT_RE =
  /(\b(npm|pnpm|yarn|bun|tsc|vite|webpack|eslint|pytest|cargo|go)\b[^\n]{0,40}\b(run|build|test|lint|install|compile)\b)|(\b(build|compile|typecheck|type-check|lint|test suite|stack trace|traceback|segfault)\b)|(\b(fix|debug|refactor|implement|add)\b[^\n]{0,60}\b(bug|error|exception|feature|function|class|module|api endpoint|unit test|typescript|python|rust|java)\b)|(\bwhy (does|is|do)\b[^\n]{0,40}\b(fail|failing|broken|error|crash)\b)|(\bthis repo(pository)?\b|\bmy project\b|\bthe codebase\b)/i;

/**
 * True when a Home-composer draft looks like repository work that Code mode
 * is equipped for. Deliberately conservative: requires a reasonably formed
 * request (≥ 24 chars) AND an explicit code-intent pattern, so everyday chat
 * ("fix my sleep schedule", "what is npm") never triggers the chip.
 */
export function suggestsCodeMode(draft: string): boolean {
  const text = (draft || "").trim();
  if (text.length < 24) return false;
  return CODE_INTENT_RE.test(text);
}
