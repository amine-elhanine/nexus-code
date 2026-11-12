// The supervisor's verification node (runVerifyNode) — extracted verbatim from
// agent-service.ts so the ~450-line verify cascade lives outside the
// runProjectAgent god function and its pure helpers stay unit-testable.
//
// Behavior is preserved exactly: `deps` carries the exact closures the inline
// version captured. Variables the run mutates while the node is alive
// (plan items, run messages, journals, the code-review counter, …) are read
// through getters so the node always sees the live value, never a snapshot
// taken at creation time.

import { promises as fsPromises, existsSync } from "node:fs";
import path from "node:path";

import { RunCancelledError } from "../command-service.js";
import { MAX_REPAIRS } from "./loop-limits.js";
import { getWorkspaceDiffFiles } from "../diff-service.js";
import { inspectDeliverables, type DeliverableInspection } from "../deliverable-inspect.js";
import { decideHomeVerification, responseHasVisualBlocks, hasChartFences, matchChartFences } from "./verify-home.js";
import { codeVerificationOutcome, parseBlockingReviewFindings, recordCodeTaskAction, shouldRunCodeReview, type CodeTaskContract, type CodeTaskJournal } from "../code-task-service.js";
import { homeRequestNamesFileFormat } from "../agent-prompt.js";
import { pickAffectedPackageCommands, pickFileScopedVerification, pickVerificationCommands, buildVerificationBatch, findTargetedTests, readPackageJsonCached, detectPackageManager } from "../task-routing.js";
import { loadedSkillNamesFromMessages } from "../tool-describe.js";
import { extractDiagnosticFeedback, VERIFY_OUTPUT_CAP } from "./message-utils.js";
import { findFreshHomeFiles, type HomeFileSnapshot } from "./home-files.js";
import { executeSubagentTask, type SubagentItem } from "../subagent-service.js";
import type { HomeTaskJournal } from "../home-task-service.js";
import type { PlanItem, HomeTaskContract, AgentEvent, AgentUsage } from "../agent-types.js";
import type { AgentMode } from "../agent-types.js";
import type { ChatMessage } from "../agentcore/messages.js";
import type { SkillListing } from "../agentcore/loop.js";
import type { AgentBackend } from "../agentcore/backend.js";
import type { CommandResult } from "../command-service.js";
import type { ArtifactValidationCache } from "../home-artifact-service.js";
import type { ArtifactItem } from "../artifacts-service.js";

export type VerifyNodeOutcome = { verification?: string; repairs?: number; verifyFeedback?: string };

export type VerifyNodeDeps = {
  // Control + transport
  isCancelled: () => boolean;
  signal?: AbortSignal | null;
  emit: (type: AgentEvent["type"], text: string, items?: PlanItem[], usage?: AgentUsage, subagent?: SubagentItem, artifact?: ArtifactItem, detail?: string, context?: AgentEvent["context"]) => void;
  runCommand: (command: string) => Promise<CommandResult>;
  usage: { addSubagent(usage?: AgentUsage): void };

  // Run configuration (stable for the lifetime of the run)
  isGeneral: boolean;
  mode: AgentMode;
  request: string;
  projectRoot: string;
  sessionId: string | undefined;
  runStartMs: number;
  homeTaskContract: HomeTaskContract | null;
  codeTaskContract: CodeTaskContract | null;
  homeArtifactCache: ArtifactValidationCache | null;
  initialDiff: Map<string, string>;
  diffFingerprint: (d: { path: string; additions: number; deletions: number }) => string;
  provider: Parameters<typeof executeSubagentTask>[0]["provider"];
  modelName: string;
  skillDirs: Parameters<typeof executeSubagentTask>[0]["skills"];
  skillListings: SkillListing[];
  agentsEnabled: boolean;
  queueCodeJournalWrite: (next: CodeTaskJournal) => void;

  // Live run state — getters so the node never sees a stale snapshot
  getIsSimple: () => boolean;
  getCodeJournal: () => CodeTaskJournal | null;
  getHomeJournal: () => HomeTaskJournal | null;
  getInitialHomeFiles: () => HomeFileSnapshot;
  getRunMessages: () => ChatMessage[];
  getLastPlanItems: () => PlanItem[] | null;
  getHomeReadOnlyStreak: () => number;
  getCompositeBackend: () => AgentBackend;
  getCodeReviewsDone: () => number;
  bumpCodeReviewsDone: () => void;
  assignDiffFiles: (files: unknown[]) => void;
};

export function createVerifyNode(deps: VerifyNodeDeps) {
  const {
    isCancelled, signal, emit, runCommand, usage,
    isGeneral, mode, request, projectRoot, sessionId, runStartMs,
    homeTaskContract, codeTaskContract, homeArtifactCache, initialDiff,
    diffFingerprint, provider, modelName, skillDirs, skillListings, agentsEnabled,
    queueCodeJournalWrite,
    getIsSimple, getCodeJournal, getHomeJournal, getInitialHomeFiles,
    getRunMessages, getLastPlanItems, getHomeReadOnlyStreak,
    getCompositeBackend, getCodeReviewsDone, bumpCodeReviewsDone, assignDiffFiles,
  } = deps;
  // The code journal is live run state: snapshot it under the caller's guard,
  // since TS cannot narrow through the getter across a callback boundary.
  const recordJournal = (action: Parameters<typeof recordCodeTaskAction>[1]): void => {
    const journal = getCodeJournal();
    if (journal) queueCodeJournalWrite(recordCodeTaskAction(journal, action));
  };
  return async (stateResponse: string, stateRepairs: number): Promise<VerifyNodeOutcome> => {

  if (isCancelled() || signal?.aborted) throw new RunCancelledError();

  if (!isGeneral) recordJournal({
      tool: "supervisor",
      summary: "Entering verification phase",
      progressed: true,
      phase: "verification",
    });

  // Home general runs do not have repository checks. Enforce the generic
  // output contract inferred from the request instead. The model decides
  // what the output should be; the runtime checks observable progress.
  // Decision logic lives in agent/verify-home.ts (pure, unit-tested) —
  // this node owns only I/O: file discovery, validation, inspection,
  // chart-dump cleanup, event emission.
  if (isGeneral) {
    const currentRepairs = Number(stateRepairs) || 0;
    const maxRepairs = MAX_REPAIRS[mode] ?? 1;
    const wantsDeliverable = Boolean(homeTaskContract?.expectsOutput);
    const freshFiles = wantsDeliverable
      ? await findFreshHomeFiles(projectRoot, getInitialHomeFiles(), runStartMs)
      : [];
    const createdDeliverable = freshFiles.length > 0;
    const artifactContract = await homeArtifactCache!.contract(freshFiles, homeTaskContract?.expectedFormats);
    const validatedDeliverable = createdDeliverable && artifactContract.valid;
    // Content-level inspection on top of structure validation: a valid
    // package with placeholder titles / thin text / no topical coverage
    // must fail with TARGETED feedback, not get announced as done.
    // Structurally-valid candidates are inspected even when the contract
    // has missing formats or invalid siblings, so one repair round sees
    // every failure class at once instead of discovering them one at a
    // time (each discovery otherwise costs a full deep_agent round-trip).
    const validCandidates = artifactContract.checks.filter((check) => check.valid).map((check) => check.path);
    const contentInspections: DeliverableInspection[] = validCandidates.length
      ? await inspectDeliverables(projectRoot, validCandidates, request)
      : [];
    const responseTextTrimmed = String(stateResponse || "").trimEnd();
    const hasVisualBlocks = responseHasVisualBlocks(responseTextTrimmed);
    const requestWantsVisuals = /\b(chart|charts|graph|graphs|diagram|diagrams|plot|plots|visual|visuals|visualization)\b/i.test(request);
    const mdFilesWithCharts: Array<{ path: string }> = [];
    // Contents cached during the scan so the chat-answer cleanup below can
    // decide chart-dump deletion without re-reading the same files.
    const mdContents = new Map<string, string>();
    if (!hasVisualBlocks && (!homeRequestNamesFileFormat(request) || requestWantsVisuals)) {
      for (const file of freshFiles) {
        if (/\.(md|markdown|txt)$/i.test(file)) {
          try {
            const content = await fsPromises.readFile(path.join(projectRoot, file), "utf8");
            mdContents.set(file, content);
            if (matchChartFences(content).length) mdFilesWithCharts.push({ path: file });
          } catch { /* ignore */ }
        }
      }
    }
    const decision = decideHomeVerification({
      request,
      response: String(stateResponse || ""),
      currentRepairs,
      maxRepairs,
      wantsDeliverable: (wantsDeliverable && !homeRequestNamesFileFormat(request) && !(homeTaskContract?.expectedFormats?.length) && !requestWantsVisuals && !createdDeliverable && !/:\s*$/s.test(responseTextTrimmed) && responseTextTrimmed.length >= 40) ? false : wantsDeliverable,
      freshFiles,
      createdDeliverable,
      artifactValid: artifactContract.valid,
      invalidArtifacts: artifactContract.invalidArtifacts,
      missingFormats: artifactContract.missingFormats,
      contentInspections,
      mdFilesWithCharts,
      planItems: getLastPlanItems(),
      evidenceActions: [
        ...(getHomeJournal()?.actions ?? []).filter((action) => action.progressed).map((action) => `${action.summary} ${action.result ?? ""}`),
        // Deliverable CONTENT is the strongest plan evidence: an item whose
        // topic words appear inside an inspected artifact is satisfied even
        // when the filename doesn't match ("Create the Troy deck" vs
        // deck.pptx).
        ...contentInspections.map((inspection) => inspection.metrics.textSample),
      ],
      homeReadOnlyStreak: getHomeReadOnlyStreak(),
      failedSkillNames: loadedSkillNamesFromMessages(getRunMessages()),
    });
    emit("tool", decision.telemetry);
    switch (decision.outcome) {
      case "chat-answer": {
        if (decision.hasVisualBlocks) {
          // Clean up any unrequested .md/.txt chart dump files created
          // alongside the chat response. The scan above only ran when the
          // response had NO visual blocks, so its cache is empty here —
          // fall back to reading the file (same as the original behavior).
          for (let i = freshFiles.length - 1; i >= 0; i--) {
            const file = freshFiles[i];
            if (/\.(md|markdown|txt)$/i.test(file)) {
              let chartDump = mdContents.has(file) ? hasChartFences(mdContents.get(file) || "") : null;
              if (chartDump === null) {
                try {
                  chartDump = hasChartFences(await fsPromises.readFile(path.join(projectRoot, file), "utf8"));
                } catch { chartDump = false; }
              }
              if (chartDump) {
                await fsPromises.unlink(path.join(projectRoot, file)).catch(() => {});
                freshFiles.splice(i, 1);
              }
            }
          }
        }
        return { verification: "none" };
      }
      case "failed-charts":
      case "failed-content":
      case "failed-plan":
        return { verification: "failed", repairs: decision.repairs, verifyFeedback: decision.verifyFeedback };
      case "failed-structure":
        // Structure failures increment repairs like every other failure:
        // unbounded structure retries (the old contract) let a model that
        // never produces a file cycle until the recursion limit. When
        // MAX_REPAIRS is exhausted with no valid output, the decision
        // falls through to failed-terminal and the run ends honestly.
        return { verification: "failed", repairs: decision.repairs, verifyFeedback: decision.verifyFeedback };
      case "passed":
      case "passed-with-warnings":
        return { verification: "passed" };
      case "failed-terminal":
        return { verification: "failed" };
      case "none":
        return { verification: "none" };
    }
  }

  const currentRepairs = Number(stateRepairs) || 0;
  const maxRepairs = MAX_REPAIRS[mode] ?? 1;

  // A denied or timed-out approval is a UI permission decision, not a
  // code problem: report skipped checks instead of sending the model
  // into "fix the dependency setup" repair loops over exit code 126.
  let anyVerificationCheckPassed = false;
  const requiredDeniedCommands: string[] = [];
  const skipIfApprovalDenied = (command: string, res: any, required = true): boolean => {
    if (!res?.approvalDenied) return false;
    if (required) requiredDeniedCommands.push(command);
    emit("tool", `Verification skipped · \`${command}\` was not approved`);
    return true;
  };

  // Diff-first, scoped to THIS run: compare against the baseline taken
  // before the agent worked. Files the run didn't touch (e.g. broken
  // edits left by an earlier interrupted run) must not trigger a
  // repair loop that hijacks a plain question. Q&A runs change zero
  // files, so they skip the typecheck + test cascade entirely.
  const diffFiles = await getWorkspaceDiffFiles(projectRoot);
  assignDiffFiles(diffFiles);
  const runDiff = diffFiles.filter((d) => initialDiff.get(d.path) !== diffFingerprint(d));
  if (runDiff.length === 0) {
    if (codeTaskContract?.expectsChanges && mode !== "plan" && currentRepairs < 1 && currentRepairs < maxRepairs) {
      emit("tool", "Verification · implementation required before completion");
      recordJournal({
          tool: "supervisor",
          summary: "Blocked completion because the requested change has not been implemented",
          progressed: false,
          phase: "implementation",
        });
      return {
        verification: "failed",
        repairs: currentRepairs + 1,
        verifyFeedback: `The request asks for a repository change, but this run has not changed any files. Do not finish with an explanation or plan. Implement the smallest correct change now, then run the appropriate verification. If the request is genuinely blocked, state the exact blocker instead of claiming completion. This reminder is sent once — after it, an honest blocker explanation is accepted as the final answer.`,
      };
    }
    return { verification: "none" };
  }
  const changedPaths = runDiff.map((d) => d.path);
  const unfinishedPlan = Boolean(getLastPlanItems()?.some((item) => item.status !== "completed"));
  // Same gate as beforeModify: complex Code change requests and complex
  // Home output contracts push unfinished-plan continuation at verify.
  const planGateActive = Boolean(isGeneral ? homeTaskContract?.expectsOutput : codeTaskContract?.expectsChanges);
  // Docs/assets-only diffs never need a typecheck: running a 30s+
  // `npm run check` for a README edit is pure "takes time, does nothing".
  const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|c|cpp|h|hpp|cs|rb|php|swift|vue|svelte)$/i;
  if (!changedPaths.some((p) => CODE_EXT.test(p))) {
    if (planGateActive && unfinishedPlan && currentRepairs < maxRepairs) {
      return {
        verification: "failed",
        repairs: currentRepairs + 1,
        verifyFeedback: "The current work unit changed files successfully, but the execution plan still has unfinished items. Continue with the next planned unit and update the todo plan before finishing.",
      };
    }
    return { verification: "passed" };
  }

  // 0. File-scoped fast path (opencode-style): small diffs lint only the
  // changed files. If it passes on a simple task, skip the full project
  // typecheck entirely.
  const scoped = pickFileScopedVerification(projectRoot, changedPaths);
  // Repair evidence: name the run's own changed files so the model fixes
  // its work directly instead of re-exploring the repo to find where the
  // error paths live.
  const changedFilesNote = changedPaths.length
    ? `\n\nFiles changed in this run: ${changedPaths.slice(0, 12).join(", ")}${changedPaths.length > 12 ? ` (+${changedPaths.length - 12} more)` : ""}. Fix the failures in these files (or in what they import) — do not restart exploration.`
    : "";
  if (scoped) {
    emit("status", `Verifying changed files with \`${scoped}\``);
    const scopedResult = await runCommand(scoped);
    if (isCancelled() || signal?.aborted) throw new RunCancelledError();
    const scopedOutput = String((scopedResult as any)?.output ?? "").trim();
    if ((scopedResult as any)?.exitCode !== 0 && !skipIfApprovalDenied(scoped, scopedResult, false)) {
      emit("tool", `Verification failed · ${scoped}`, undefined, undefined, undefined, undefined, extractDiagnosticFeedback(scopedOutput));
      if (currentRepairs < maxRepairs && scopedOutput) {
        return {
          repairs: currentRepairs + 1,
          verifyFeedback: `The scoped check \`${scoped}\` failed (self-healing repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${extractDiagnosticFeedback(scopedOutput)}${changedFilesNote}\n\nFix these failures with minimal, focused changes, then summarize what you changed.`,
        };
      }
      return { verification: "failed" };
    }
    if (!(scopedResult as any)?.approvalDenied) {
      anyVerificationCheckPassed = true;
      emit("tool", `Verification passed · ${scoped}`);
      if (getIsSimple()) return { verification: "passed" };
    }
  }

  // Fresh scaffold: package.json appeared and dependencies were never
  // installed. Install once, then verify with the production build
  // instead of a bare typecheck — a new app must compile before handoff.
  let staticCommand: string | null = null;
  {
    const root = path.resolve(projectRoot);
    const pm = detectPackageManager(root);
    const scaffolded = changedPaths.includes("package.json") && !existsSync(path.join(root, "node_modules"));
    if (scaffolded) {
      emit("status", `Installing dependencies for the new project (${pm.install})`);
      const installResult = await runCommand(pm.install);
      if (isCancelled() || signal?.aborted) throw new RunCancelledError();
      const installOutput = String((installResult as any)?.output ?? "").trim();
      if ((installResult as any)?.exitCode !== 0) {
        if (skipIfApprovalDenied(pm.install, installResult)) {
          // Without dependencies nothing downstream can run: end the
          // verification honestly instead of failing.
          return { verification: "none" };
        }
        emit("tool", `Verification failed · ${pm.install}`);
        if (currentRepairs < maxRepairs && installOutput) {
          return {
            repairs: currentRepairs + 1,
            verifyFeedback: `${pm.install} failed (self-healing repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${extractDiagnosticFeedback(installOutput)}\n\nFix the dependency setup (package.json, registry access, Node version), then summarize what you changed.`,
          };
        }
        return { verification: "failed" };
      }
      emit("tool", `Dependency installation completed · ${pm.install}`);
      const scripts = readPackageJsonCached(root)?.scripts ?? {};
      if (typeof scripts.build === "string") staticCommand = `${pm.run} build`;
    }
  }

  // 1. Static/build checks. Projects may override the heuristic with
  // .nexus/verification.json or package.json.nexus.verification.commands.
  // P1: run them in parallel (cap 4) instead of serial fail-fast so a
  // typecheck + lint + test trio reports all failures in one repair pass.
  const affectedCommands = pickAffectedPackageCommands(projectRoot, changedPaths);
  const configuredCommands = staticCommand
    ? [staticCommand]
    : affectedCommands.length ? affectedCommands : pickVerificationCommands(projectRoot);
  const pickFormatterCommand = ((): string | null => {
    try {
      const root = path.resolve(projectRoot);
      const pkg = readPackageJsonCached(root);
      const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
      if (!deps.prettier && typeof pkg?.scripts?.format !== "string") return null;
      if (!changedPaths.some((p) => /\.(ts|tsx|js|jsx|mjs|cjs|json|css|md)$/i.test(p))) return null;
      const pmInner = detectPackageManager(root);
      if (typeof pkg?.scripts?.format === "string" && /check/i.test(String(pkg.scripts.format))) return `${pmInner.run} format`;
      if (deps.prettier) return `${pmInner.exec} prettier --check ${changedPaths.filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs|json|css|md)$/i.test(p)).slice(0, 5).map((f) => `"${f.replace(/"/g, "")}"`).join(" ")}`;
      return null;
    } catch {
      return null;
    }
  })();
  const verifyBatch = buildVerificationBatch(configuredCommands, pickFormatterCommand);
  if (verifyBatch.length > 1) {
    emit("status", `Verifying changes (${verifyBatch.length} checks in parallel)`);
    const settled = await Promise.allSettled(verifyBatch.map((cmd) => runCommand(cmd)));
    const failures: Array<{ command: string; output: string }> = [];
    settled.forEach((entry, index) => {
      const command = verifyBatch[index];
      if (isCancelled() || signal?.aborted) throw new RunCancelledError();
      if (entry.status === "rejected") {
        failures.push({ command, output: String((entry.reason as Error)?.message || entry.reason) });
        emit("tool", `Verification failed · ${command}`);
      } else {
        const output = String((entry.value as any)?.output ?? "").trim();
        if ((entry.value as any)?.exitCode !== 0) {
          if (skipIfApprovalDenied(command, entry.value, configuredCommands.includes(command))) return;
          failures.push({ command, output });
          emit("tool", `Verification failed · ${command}`, undefined, undefined, undefined, undefined, extractDiagnosticFeedback(output));
        } else {
          if (configuredCommands.includes(command)) anyVerificationCheckPassed = true;
          emit("tool", `Verification passed · ${command}`);
        }
      }
    });
    if (failures.length > 0) {
      const combined = failures.map((f) => `### ${f.command}\n${extractDiagnosticFeedback(f.output)}`).join("\n\n").slice(0, VERIFY_OUTPUT_CAP);
      if (currentRepairs < maxRepairs) {
        return {
          repairs: currentRepairs + 1,
          verifyFeedback: `Parallel verification failed (${failures.length}/${verifyBatch.length}, repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${combined}${changedFilesNote}\n\nFix these failures with minimal, focused changes, then summarize what you changed.`,
        };
      }
      return { verification: "failed" };
    }
  } else if (verifyBatch.length > 0) for (const verificationCommand of verifyBatch) {
    const required = configuredCommands.includes(verificationCommand);
    emit("status", `Verifying changes with \`${verificationCommand}\``);
    const result = await runCommand(verificationCommand);
    if (isCancelled() || signal?.aborted) throw new RunCancelledError();
    const output = String((result as any)?.output ?? "").trim();
    if ((result as any)?.exitCode !== 0) {
      if (skipIfApprovalDenied(verificationCommand, result, required)) continue;
      emit("tool", `Verification failed · ${verificationCommand}`, undefined, undefined, undefined, undefined, extractDiagnosticFeedback(output));
      if (currentRepairs < maxRepairs && output) {
        return {
          repairs: currentRepairs + 1,
          verifyFeedback: `The verification command \`${verificationCommand}\` failed (self-healing repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${extractDiagnosticFeedback(output)}${changedFilesNote}\n\nFix these failures with minimal, focused changes, then summarize what you changed.`,
        };
      }
      return { verification: "failed" };
    }
    if (required) anyVerificationCheckPassed = true;
    emit("tool", `Verification passed · ${verificationCommand}`);
  }

  if (requiredDeniedCommands.length) {
    emit("status", `Verification incomplete — approval was denied for required checks: ${requiredDeniedCommands.join(", ")}`);
    return { verification: "none" };
  }

  // 2. Targeted test detection for modified files (reuse the diff above)
  const targetTestCmd = findTargetedTests(projectRoot, changedPaths);
  if (targetTestCmd) {
    emit("status", `Running targeted test \`${targetTestCmd}\``);
    const testResult = await runCommand(targetTestCmd);
    if (isCancelled() || signal?.aborted) throw new RunCancelledError();
    const testOutput = String((testResult as any)?.output ?? "").trim();
    if ((testResult as any)?.exitCode !== 0) {
      if (skipIfApprovalDenied(targetTestCmd, testResult, true)) {
        // Skipped, not failed — approval is a user decision.
      } else {
        emit("tool", `Targeted test failed · ${targetTestCmd}`, undefined, undefined, undefined, undefined, extractDiagnosticFeedback(testOutput));
        if (currentRepairs < maxRepairs && testOutput) {
          return {
            repairs: currentRepairs + 1,
            verifyFeedback: `Targeted test \`${targetTestCmd}\` failed (self-healing repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${extractDiagnosticFeedback(testOutput)}\n\nFix the code to pass this test.`,
          };
        }
        return { verification: "failed" };
      }
    } else {
      anyVerificationCheckPassed = true;
      emit("tool", `Targeted test passed · ${targetTestCmd}`);
    }
  }

  // Auto mode gets one bounded, read-only review after verification and
  // before completion. Blocking findings return the task to implementation.
  const changedFilesCount = changedPaths.length;
  const changedLinesApprox = (diffFiles || []).reduce((acc: number, f: any) => acc + (Number(f?.insertions || 0) + Number(f?.deletions || 0)), 0);
  const isHighImpact = changedPaths.some((p: string) => /auth|security|payment|migration|schema|secret|token|gateway/i.test(p));
  if (shouldRunCodeReview({
    agentsEnabled,
    mode,
    expectsChanges: Boolean(codeTaskContract?.expectsChanges),
    currentRepairs,
    maxRepairs,
    changedFiles: changedFilesCount,
    changedLines: changedLinesApprox,
    highImpact: isHighImpact,
    reviewsDone: getCodeReviewsDone(),
  })) {
    bumpCodeReviewsDone();
    emit("status", "Reviewing the completed work with a read-only reviewer…");
    recordJournal({
        tool: "code-reviewer",
        summary: `Reviewing ${changedPaths.length} changed file${changedPaths.length === 1 ? "" : "s"}`,
        progressed: true,
        phase: "review",
        changedFiles: changedPaths,
      });
    const review = await executeSubagentTask({
      role: "code-reviewer",
      task: `Review only this run's changes. Changed paths:\n${changedPaths.slice(0, 40).join("\n")}\n\nCheck correctness, regressions, error handling, security, and incomplete acceptance criteria. Report each finding on its own line in exactly this format:\nSEVERITY | path | issue\nwhere SEVERITY is CRITICAL, HIGH, MEDIUM, or LOW. If there are no blocking issues, reply with exactly "No blocking findings." Do not edit files.`,
      projectRoot,
      provider,
      modelName,
      projectRecord: { id: "current", name: "current", root: projectRoot },
      mcpTools: [],
      skills: skillDirs,
      skillListings,
      skillsBackend: getCompositeBackend(),
      onEvent: (subEvent) => {
        usage.addSubagent(subEvent.subagent.usage);
        emit("subagent", subEvent.type === "subagent_start" ? "Delegated read-only code review" : subEvent.type === "subagent_finish" ? "Read-only code review completed" : "Code reviewer working…", undefined, undefined, subEvent.subagent);
      },
      isCancelled,
      runId: sessionId,
    });
    // Only explicitly formatted finding lines count as blocking (parser
    // unit-tested in code-task.test.mjs). A bare "CRITICAL"/"HIGH"
    // mention in prose must not trigger a repair loop.
    const blockingFindings = parseBlockingReviewFindings(review);
    if (blockingFindings.length > 0) {
      return {
        verification: "failed",
        repairs: currentRepairs + 1,
        verifyFeedback: `The read-only code review found blocking findings. Fix them before finishing:\n\n${blockingFindings.slice(0, 6).join("\n\n")}\n\nRe-run verification after the fixes.`,
      };
    }
  }

  if (planGateActive && unfinishedPlan && currentRepairs < maxRepairs) {
    const remaining = getLastPlanItems()!
      .filter((item) => item.status !== "completed")
      .slice(0, 8)
      .map((item) => `- ${item.content} (${item.status})`)
      .join("\n");
    emit("tool", "Verification · work remains in the execution plan");
    recordJournal({
        tool: "supervisor",
        summary: "Verification passed for the current work unit; continuing with unfinished plan items",
        progressed: true,
        phase: "implementation",
      });
    return {
      verification: "failed",
      repairs: currentRepairs + 1,
      verifyFeedback: `The current work unit passed verification, but the execution plan is not complete. Continue with the next unfinished work unit instead of finishing early. Remaining plan items:\n${remaining}\n\nUpdate the todo plan as each unit is completed, then verify again.`,
    };
  }
  return {
    verification: codeVerificationOutcome({
      passedCheck: anyVerificationCheckPassed,
      requiredCheckDenied: requiredDeniedCommands.length > 0,
    }),
  };
    };
}
