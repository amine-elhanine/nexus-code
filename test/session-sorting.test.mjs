import assert from "node:assert/strict";
import { sortSessionsInPlace } from "../dist-electron/store.js";

console.log("[test] Running session sorting tests...");

// Test 1: Basic descending sort by updatedAt
const sessions = [
  { id: "s1", title: "Old Chat", createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-01T10:00:00Z", memory: "", messages: [] },
  { id: "s2", title: "Newer Chat", createdAt: "2026-09-02T10:00:00Z", updatedAt: "2026-09-02T10:00:00Z", memory: "", messages: [] },
  { id: "s3", title: "Middle Chat", createdAt: "2026-09-01T15:00:00Z", updatedAt: "2026-09-01T15:00:00Z", memory: "", messages: [] },
];

sortSessionsInPlace(sessions);
assert.equal(sessions[0].id, "s2", "Latest session should be at index 0");
assert.equal(sessions[1].id, "s3", "Middle session should be at index 1");
assert.equal(sessions[2].id, "s1", "Oldest session should be at index 2");

// Test 2: Sending a message into an old session moves it to top
const oldSession = sessions.find((s) => s.id === "s1");
oldSession.updatedAt = "2026-09-03T12:00:00Z";
sortSessionsInPlace(sessions);
assert.equal(sessions[0].id, "s1", "Updated old session should immediately jump to index 0");
assert.equal(sessions[1].id, "s2", "Previous newest session is now second");
assert.equal(sessions[2].id, "s3", "Remaining session is last");

// Test 3: Fallback to createdAt if updatedAt is missing
const fallbackSessions = [
  { id: "a", title: "Chat A", createdAt: "2026-09-01T10:00:00Z", memory: "", messages: [] },
  { id: "b", title: "Chat B", createdAt: "2026-09-03T10:00:00Z", memory: "", messages: [] },
];
sortSessionsInPlace(fallbackSessions);
assert.equal(fallbackSessions[0].id, "b", "Session with newer createdAt should be first");
assert.equal(fallbackSessions[1].id, "a", "Session with older createdAt should be second");

console.log("[test] Session sorting tests passed successfully!");
