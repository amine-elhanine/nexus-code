import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Point the Home workspace at a scratch dir BEFORE importing the compiled
// service — getHomeRoot() honors NEXUS_HOME_ROOT so tests never touch the
// user's real Documents folder.
const tempHome = path.join(os.tmpdir(), `nexus-test-home-${Date.now()}`);
fs.mkdirSync(path.join(tempHome, ".nexus"), { recursive: true });
process.env.NEXUS_HOME_ROOT = tempHome;

const {
  listHomeSessionFiles,
  listHomeSessionFilesForDeletion,
  recordHomeFilesOwnedBySession,
  removeSessionFromManifest,
  loadHomeManifest,
} = await import("../dist-electron/home-service.js");

console.log("[test] Running home session files attribution tests...");

function writeHomeFile(name, mtimeIso) {
  const abs = path.join(tempHome, name);
  fs.writeFileSync(abs, `content of ${name}`);
  const t = new Date(mtimeIso);
  fs.utimesSync(abs, t, t);
  return { name, path: name.replace(/\\/g, "/"), size: fs.statSync(abs).size, modified: new Date(fs.statSync(abs).mtimeMs).toISOString() };
}

const olderSession = {
  id: "session_older_123",
  title: "Older Course Session",
  createdAt: "2026-09-21T10:00:00Z",
  updatedAt: "2026-09-22T17:41:00Z",
  messages: [
    { role: "user", text: "Please generate a presentation about agentic AI", createdAt: "2026-09-22T17:38:00Z" },
    { role: "assistant", text: "Here is your deliverable: presentation.pptx (50 slides).", createdAt: "2026-09-22T17:39:45Z" },
  ],
};
const newerSession = {
  id: "session_newer_456",
  title: "Newer Session",
  createdAt: "2026-09-22T16:00:00Z",
  updatedAt: "2026-09-22T16:15:00Z",
  messages: [
    { role: "user", text: "Hello, what can you do?", createdAt: "2026-09-22T16:05:00Z" },
  ],
};
const sessions = [olderSession, newerSession];

// 1. Manifest ownership drives both display and deletion.
writeHomeFile("report.docx", "2026-09-22T17:39:39.000Z");
await recordHomeFilesOwnedBySession(olderSession.id, ["report.docx"]);
{
  const owned = await listHomeSessionFiles(olderSession.id, sessions);
  assert.ok(owned.some((f) => f.path === "report.docx"), "manifest-owned file shows for its session");
  const otherView = await listHomeSessionFiles(newerSession.id, sessions);
  assert.ok(!otherView.some((f) => f.path === "report.docx"), "manifest-owned file does not show for other sessions");
  const deletable = await listHomeSessionFilesForDeletion(olderSession.id, sessions);
  assert.ok(deletable.some((f) => f.path === "report.docx"), "manifest-owned file is deletable with its session");
}

// 2. Transcript mention: presentation.pptx named only in olderSession's turns.
writeHomeFile("presentation.pptx", "2026-09-22T17:39:39.000Z");
{
  const owned = await listHomeSessionFiles(olderSession.id, sessions);
  assert.ok(owned.some((f) => f.path === "presentation.pptx"), "transcript-mentioned file attributed to the mentioning session");
  const deletable = await listHomeSessionFilesForDeletion(olderSession.id, sessions);
  assert.ok(deletable.some((f) => f.path === "presentation.pptx"), "transcript mention is high-confidence ownership");
}

// 3. Proximity-only attribution is display-only: NOT deletable.
writeHomeFile("diagram.png", "2026-09-22T17:40:00.000Z");
{
  const owned = await listHomeSessionFiles(olderSession.id, sessions);
  assert.ok(owned.some((f) => f.path === "diagram.png"), "proximity still attributes the file for display");
  const deletable = await listHomeSessionFilesForDeletion(olderSession.id, sessions);
  assert.ok(!deletable.some((f) => f.path === "diagram.png"), "proximity-only attribution must NOT authorize deletion");
}

// 4. Unclaimed pre-existing file: display fallback may show it as oldest
// session's, but deletion must never touch it.
writeHomeFile("user_notes.txt", "2026-09-20T08:00:00.000Z");
{
  const deletableOlder = await listHomeSessionFilesForDeletion(olderSession.id, sessions);
  const deletableNewer = await listHomeSessionFilesForDeletion(newerSession.id, sessions);
  assert.ok(!deletableOlder.some((f) => f.path === "user_notes.txt"), "oldest-session fallback must NOT authorize deletion (older)");
  assert.ok(!deletableNewer.some((f) => f.path === "user_notes.txt"), "oldest-session fallback must NOT authorize deletion (newer)");
}

// 5. removeSessionFromManifest clears only that session's entries.
await removeSessionFromManifest(olderSession.id);
{
  const manifest = await loadHomeManifest();
  assert.ok(!manifest["report.docx"], "manifest entry removed with the session");
}

// 6. Transcript-mention promotion persists through the locked mutate path.
const promoSession = {
  id: "session_promo_789",
  title: "Promo Session",
  createdAt: "2026-09-22T17:00:00Z",
  updatedAt: "2026-09-22T17:43:00Z",
  messages: [
    { role: "assistant", text: "Done — the file is summary.md, ready to download.", createdAt: "2026-09-22T17:41:25Z" },
  ],
};
writeHomeFile("summary.md", "2026-09-22T17:41:30.000Z");
{
  const owned = await listHomeSessionFiles(promoSession.id, [promoSession, olderSession, newerSession]);
  assert.ok(owned.some((f) => f.path === "summary.md"), "mention attributed for display");
  const manifest = await loadHomeManifest();
  assert.equal(manifest["summary.md"]?.sessionId, promoSession.id, "mention promoted to durable manifest ownership");
  const deletable = await listHomeSessionFilesForDeletion(promoSession.id, [promoSession, olderSession, newerSession]);
  assert.ok(deletable.some((f) => f.path === "summary.md"), "promoted mention is deletable with its session");
}

// 7. First writer wins: once a session owns a file in the manifest, a later
// listing for a different session must not stomp that entry. shared.pdf is
// proximity-attributed first (display-only), then explicitly recorded.
writeHomeFile("shared.pdf", "2026-09-22T17:42:00.000Z");
{
  const owned = await listHomeSessionFiles(olderSession.id, sessions);
  assert.ok(owned.some((f) => f.path === "shared.pdf"), "unclaimed file attributed for display by proximity");
  await recordHomeFilesOwnedBySession(newerSession.id, ["shared.pdf"]);
  const ownedAfter = await listHomeSessionFiles(olderSession.id, sessions);
  assert.ok(!ownedAfter.some((f) => f.path === "shared.pdf"), "manifest owner keeps the file on re-listing");
  const manifest = await loadHomeManifest();
  assert.equal(manifest["shared.pdf"]?.sessionId, newerSession.id, "explicit run attribution beats the display guess");
}

// Cleanup
delete process.env.NEXUS_HOME_ROOT;
fs.rmSync(tempHome, { recursive: true, force: true });

console.log("[test] Home session files attribution tests passed successfully!");
