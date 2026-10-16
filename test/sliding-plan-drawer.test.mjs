import test from "node:test";
import assert from "node:assert/strict";

// Mirror extractLatestPlan logic for node environment verification
function extractLatestPlan(liveEvents, messages) {
  if (liveEvents && liveEvents.length > 0) {
    for (let i = liveEvents.length - 1; i >= 0; i--) {
      const ev = liveEvents[i];
      if (ev.kind === "plan" && ev.plan && ev.plan.length > 0) {
        return { plan: ev.plan, createdAt: ev.createdAt };
      }
    }
  }
  if (messages && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.kind === "plan" && msg.plan && msg.plan.length > 0) {
        return { plan: msg.plan, createdAt: msg.createdAt };
      }
    }
  }
  return null;
}

test("extractLatestPlan: Returns null when no plan events exist", () => {
  const result = extractLatestPlan([], []);
  assert.equal(result, null);
});

test("extractLatestPlan: Extracts plan from liveEvents in real time during agent run", () => {
  const liveEvents = [
    { role: "event", kind: "status", text: "Starting task", createdAt: "2026-10-14T10:00:00Z" },
    {
      role: "event",
      kind: "plan",
      text: "Working plan",
      createdAt: "2026-10-14T10:00:05Z",
      plan: [
        { content: "Deduplicate CSS", status: "completed" },
        { content: "Replace hardcoded colors", status: "in_progress" },
        { content: "Verify build", status: "pending" },
      ],
    },
    { role: "event", kind: "tool", text: "read_file", createdAt: "2026-10-14T10:00:10Z" },
  ];

  const result = extractLatestPlan(liveEvents, []);
  assert.ok(result);
  assert.equal(result.plan.length, 3);
  assert.equal(result.plan[0].status, "completed");
  assert.equal(result.plan[1].status, "in_progress");
  assert.equal(result.plan[2].status, "pending");
});

test("extractLatestPlan: Prefers latest liveEvents plan over older messages plan", () => {
  const messages = [
    {
      role: "event",
      kind: "plan",
      createdAt: "2026-10-14T09:00:00Z",
      plan: [{ content: "Old plan item", status: "completed" }],
    },
  ];

  const liveEvents = [
    {
      role: "event",
      kind: "plan",
      createdAt: "2026-10-14T10:00:00Z",
      plan: [
        { content: "New step 1", status: "completed" },
        { content: "New step 2", status: "in_progress" },
      ],
    },
  ];

  const result = extractLatestPlan(liveEvents, messages);
  assert.ok(result);
  assert.equal(result.plan.length, 2);
  assert.equal(result.plan[0].content, "New step 1");
});

test("extractLatestPlan: Falls back to messages when no active live run", () => {
  const messages = [
    {
      role: "event",
      kind: "plan",
      createdAt: "2026-10-14T09:00:00Z",
      plan: [
        { content: "Step 1", status: "completed" },
        { content: "Step 2", status: "completed" },
      ],
    },
  ];

  const result = extractLatestPlan([], messages);
  assert.ok(result);
  assert.equal(result.plan.length, 2);
  assert.equal(result.plan[0].status, "completed");
  assert.equal(result.plan[1].status, "completed");
});

test("Steps Isolation: Plan events are skipped from step groups so they never clutter timeline steps", () => {
  const rawEvents = [
    { role: "event", kind: "status", text: "Agent is working" },
    { role: "event", kind: "plan", text: "Working plan", plan: [{ content: "Step A", status: "pending" }] },
    { role: "event", kind: "tool", text: "read_file" },
  ];

  // Mirror groupEvents filter
  const steps = [];
  for (const event of rawEvents) {
    if (event.kind === "plan") continue; // Excluded from steps timeline
    steps.push(event);
  }

  assert.equal(steps.length, 2);
  assert.ok(!steps.some((s) => s.kind === "plan"));
});
