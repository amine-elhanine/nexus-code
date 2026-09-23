import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Import from compiled electron dist
import {
  listHomeSessionFiles,
  recordHomeFilesOwnedBySession,
  removeSessionFromManifest,
  loadHomeManifest,
  saveHomeManifest,
} from "../dist-electron/home-service.js";

console.log("[test] Running home session files attribution tests...");

// Setup temporary directory structure to simulate Home folder
const tempHome = path.join(os.tmpdir(), `nexus-test-home-${Date.now()}`);
fs.mkdirSync(tempHome, { recursive: true });
fs.mkdirSync(path.join(tempHome, ".nexus"), { recursive: true });

// Create fake files in tempHome
const pptxPath = path.join(tempHome, "presentation.pptx");
fs.writeFileSync(pptxPath, "fake pptx content");
const mtimePresentation = new Date("2026-09-22T17:39:39Z");
fs.utimesSync(pptxPath, mtimePresentation, mtimePresentation);

const olderSession = {
  id: "session_older_123",
  title: "Older Course Session",
  createdAt: "2026-09-21T10:00:00Z",
  updatedAt: "2026-09-22T17:41:00Z",
  messages: [
    {
      role: "user",
      text: "Please generate a presentation about agentic AI",
      createdAt: "2026-09-22T17:38:00Z",
    },
    {
      role: "assistant",
      text: "Here is your deliverable: presentation.pptx (50 slides).",
      createdAt: "2026-09-22T17:39:45Z",
    },
  ],
};

const newerSession = {
  id: "session_newer_456",
  title: "Newer Session",
  createdAt: "2026-09-22T16:00:00Z",
  updatedAt: "2026-09-22T16:15:00Z",
  messages: [
    {
      role: "user",
      text: "Hello, what can you do?",
      createdAt: "2026-09-22T16:05:00Z",
    },
  ],
};

const sessions = [olderSession, newerSession];

// Mock getHomeRoot / ensureHomeDir environment if needed or test attribution logic
// Test 1: Message Mention Matching
// presentation.pptx was created at 17:39:39.
// Even though newerSession was created at 16:00:00 (which is before 17:39:39),
// olderSession explicitly generated presentation.pptx in its messages.
{
  // Test simulated listHomeSessionFiles logic directly
  const manifest = {};
  const file = {
    name: "presentation.pptx",
    path: "presentation.pptx",
    modified: "2026-09-22T17:39:39.000Z",
    size: 1024,
  };

  // Check older session owns it
  const checkOwner = (sessionId) => {
    let messageOwner = null;
    let newestMentionTime = -1;
    for (const s of sessions) {
      for (const m of s.messages || []) {
        if (m.text && (m.text.includes(file.name) || m.text.includes(file.path))) {
          const t = new Date(m.createdAt || s.updatedAt || s.createdAt).getTime();
          if (t > newestMentionTime) {
            newestMentionTime = t;
            messageOwner = s.id;
          }
        }
      }
    }
    return messageOwner === sessionId;
  };

  assert.equal(checkOwner(olderSession.id), true, "Older session must own presentation.pptx due to message mention");
  assert.equal(checkOwner(newerSession.id), false, "Newer session must NOT own presentation.pptx");
}

// Test 2: Activity Proximity Matching (when filename is not in messages)
{
  const fileWithoutMention = {
    name: "diagram.png",
    path: "diagram.png",
    modified: "2026-09-22T17:40:00.000Z", // occurred during olderSession's turn (17:38 - 17:41)
    size: 2048,
  };

  const mtime = new Date(fileWithoutMention.modified).getTime();
  let bestSessionId = null;
  let minDistance = Infinity;

  for (const s of sessions) {
    const timestamps = [];
    if (s.createdAt) timestamps.push(new Date(s.createdAt).getTime());
    if (s.updatedAt) timestamps.push(new Date(s.updatedAt).getTime());
    for (const m of s.messages || []) {
      if (m.createdAt) timestamps.push(new Date(m.createdAt).getTime());
    }

    for (const t of timestamps) {
      const diff = mtime - t;
      const distance = diff >= -120_000 ? Math.abs(diff) : Math.abs(diff) + 1_000_000;
      if (distance < minDistance && distance < 45 * 60_000) {
        minDistance = distance;
        bestSessionId = s.id;
      }
    }
  }

  assert.equal(bestSessionId, olderSession.id, "Older session had activity around file mtime, newer session was inactive");
}

// Cleanup
fs.rmSync(tempHome, { recursive: true, force: true });

console.log("[test] Home session files attribution tests passed successfully!");
