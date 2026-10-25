import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserTools } from "../dist-electron/browser-tool.js";
import { agentBrowserService } from "../dist-electron/browser-service.js";
import { extractLocalDevServerUrl, isLikelyDevServerCommand, waitForLocalServer } from "../dist-electron/project-preview.js";

test("project preview detection accepts local dev URLs and ignores non-server commands", () => {
  assert.equal(isLikelyDevServerCommand("npm run dev -- --host 0.0.0.0"), true);
  assert.equal(isLikelyDevServerCommand("pnpm start"), true);
  assert.equal(isLikelyDevServerCommand("npm test"), false);
  assert.equal(extractLocalDevServerUrl("Local: \u001b[32mhttp://localhost:5173/\u001b[0m"), "http://localhost:5173/");
  assert.equal(extractLocalDevServerUrl("Serving at http://0.0.0.0:3000/"), "http://localhost:3000/");
  assert.equal(extractLocalDevServerUrl("Network: http://192.168.1.8:3000/"), null);
});

test("server readiness probe waits for a responding loopback app only", async () => {
  let attempts = 0;
  assert.equal(await waitForLocalServer("http://127.0.0.1:5173/", 2000, async () => ++attempts >= 3), true);
  assert.equal(attempts, 3);
  let externalProbeCalled = false;
  assert.equal(await waitForLocalServer("https://example.com", 10, async () => { externalProbeCalled = true; return true; }), false);
  assert.equal(externalProbeCalled, false, "readiness checks are restricted to loopback hosts");
});

test("browser_act forwards explicit open-in-browser intent", async () => {
  const calls = [];
  const tools = createBrowserTools("/test", {
    agentBrowser: {
      inspect: async () => "",
      act: async (input) => {
        calls.push(input);
        return "opened";
      },
    },
  });
  const browserAct = tools.find((candidate) => candidate.name === "browser_act");
  assert.ok(browserAct);
  assert.equal(await browserAct.invoke({ action: "navigate", url: "http://localhost:5173", openInBrowser: true }), "opened");
  assert.equal(calls[0].openInBrowser, true);
});

test("explicit preview navigation requests force-follow even when headless browsing is enabled", async () => {
  const activities = [];
  agentBrowserService.onActivity = (activity) => activities.push(activity);
  agentBrowserService.setSender((message) => {
    const value = message.kind === "eval"
      ? { url: "http://localhost:5173/", title: "Local app", count: 0, elements: [] }
      : undefined;
    setImmediate(() => agentBrowserService.handleReply({
      id: message.id,
      reply: { ok: true, url: message.url || "http://localhost:5173/", value },
    }));
  });
  try {
    await agentBrowserService.act(
      { action: "navigate", url: "http://localhost:5173", openInBrowser: true },
      undefined,
      { sessionId: "preview-test", scope: "code", openInBrowser: true },
    );
    assert.equal(activities.at(-1)?.autoFollow, true);
    assert.equal(activities.at(-1)?.forceFollow, true);
    assert.equal(activities.at(-1)?.sessionId, "preview-test");
  } finally {
    agentBrowserService.setSender(null);
    agentBrowserService.onActivity = null;
  }
});
