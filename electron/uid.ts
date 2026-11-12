// Shared id generator (was duplicated in store.ts and notebook-text.ts and
// could drift). Time-ordered-ish: prefix_ base36 timestamp _ random suffix.
export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
