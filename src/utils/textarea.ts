/**
 * Replace the trigger token (a @mention or /slash command) immediately before
 * the textarea cursor with `replacement`, returning the new draft value and
 * the cursor offset just after the inserted text. Returns null when there is
 * no textarea to read the cursor from; callers treat that as a no-op.
 */
export function insertAtCursor(
  textarea: HTMLTextAreaElement | null,
  draft: string,
  pattern: RegExp,
  replacement: string | ((substring: string, ...args: any[]) => string),
): { nextDraft: string; cursor: number } | null {
  if (!textarea) return null;
  const cursor = textarea.selectionStart || draft.length;
  const beforeCursor = draft.slice(0, cursor);
  const afterCursor = draft.slice(cursor);
  const updatedBefore =
    typeof replacement === "function"
      ? beforeCursor.replace(pattern, replacement)
      : beforeCursor.replace(pattern, replacement);
  return { nextDraft: `${updatedBefore}${afterCursor}`, cursor: updatedBefore.length };
}
