import type { ChatItem } from "../types.js";
import type { InspectorGoal, InspectorTask } from "../components/code/CodeInspectorSidebar.js";
import { extractLatestPlan } from "../components/chat/SlidingPlanDrawer.js";

/**
 * Assemble inspector tasks from background daemons and executed session tool calls.
 */
export function buildInspectorTasks(
  daemons: Array<{ id: string; name?: string; command: string; status: string }>,
  messages: ChatItem[]
): InspectorTask[] {
  const list: InspectorTask[] = [];

  for (const d of daemons) {
    list.push({
      id: d.id,
      name: d.name || d.command,
      status: d.status === "running" ? "running" : d.status === "crashed" ? "crashed" : "stopped",
      command: d.command,
    });
  }

  for (const msg of messages) {
    // Tool-call payloads ride on event messages; the ChatItem type doesn't
    // model `toolCalls`, so read it through a loose shape.
    const loose = msg as unknown as { toolCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> };
    if (msg.kind === "tool" || (loose.toolCalls && loose.toolCalls.length > 0)) {
      for (const tc of loose.toolCalls || []) {
        if (tc.name === "run_command" || tc.name === "bash") {
          const cmd = (tc.args?.toolSummary as string) || (tc.args?.CommandLine as string) || (tc.args?.command as string);
          if (cmd && !list.some((item) => item.name === cmd)) {
            list.push({
              id: `tool-${tc.id || list.length}`,
              name: (tc.args?.toolSummary as string) || `Run ${cmd.slice(0, 30)}`,
              status: "stopped",
              command: cmd,
            });
          }
        } else if (tc.name === "schedule") {
          list.push({
            id: `sched-${tc.id || list.length}`,
            name: (tc.args?.Prompt as string) || "10s timer",
            status: "timer",
            command: "schedule",
          });
        }
      }
    }
  }

  return list;
}

/**
 * Assemble inspector goals from the latest plan steps or user conversation checkpoints.
 */
export function buildInspectorGoals(
  liveEvents: ChatItem[],
  messages: ChatItem[],
  running: boolean
): InspectorGoal[] {
  const goals: InspectorGoal[] = [];

  const plan = extractLatestPlan(liveEvents, messages, running);
  if (plan?.plan && plan.plan.length > 0) {
    for (let i = 0; i < plan.plan.length; i++) {
      const step = plan.plan[i];
      goals.push({
        id: `step-${i}`,
        text: step.content,
        status: step.status === "completed" ? "completed" : step.status === "in_progress" ? "in_progress" : "pending",
      });
    }
  } else {
    const userMsgs = messages.filter((m) => m.role === "user");
    for (let i = 0; i < userMsgs.length; i++) {
      const u = userMsgs[i];
      const text = (u.text || "").replace(/^\/goal\s+/i, "").trim();
      if (text) {
        const isLatest = i === userMsgs.length - 1;
        goals.push({
          id: `goal-${i}`,
          text: text.length > 60 ? `${text.slice(0, 60)}...` : text,
          status: isLatest && running ? "in_progress" : "completed",
        });
      }
    }
  }

  return goals;
}
