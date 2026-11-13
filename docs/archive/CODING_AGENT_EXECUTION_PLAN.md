# Nexus Coding Agent Execution Plan

Use this as the implementation brief for bringing Nexus closer to Claude Code and Codex. Work in small reviewable changes, keep the desktop app working, and prioritize the coding loop over feature count.

**Latest execution evidence:** [24 October 2026 validation report](reports/execution-status-2026-10-24.md). The Phase 0 checks and current Phase 1 security work have been exercised; live model benchmarking, packaged smoke coverage, and a few platform-specific checks remain. A Home-mode long-task continuity slice is also implemented and recorded there.

## Mission

Make Nexus Code mode a dependable, safe, measurable repository coding agent, then make the same task usable from the terminal and an IDE. Preserve Home and Notebook as differentiators, but avoid expanding them while core Code-mode reliability and trust gaps remain.

## Working rules for the agent

1. Start by inspecting the current branch, worktree, `git status`, repository instructions, and existing CI. Do not overwrite or revert user changes. The checkout may contain unrelated edits; preserve them.
2. Read the relevant modules and tests before editing. Follow local `AGENTS.md` instructions when they apply.
3. For each task, state the observed problem, evidence, intended behavior, and acceptance checks before changing code. Implement the smallest coherent vertical slice, not a broad rewrite.
4. Treat safety boundaries as product behavior: validate all renderer IPC inputs in the main process, deny by default for untrusted capabilities, keep approvals auditable, and do not describe pattern filters or Node VM isolation as a secure OS sandbox.
5. Add regression tests for changed behavior. Run the narrowest relevant tests first, then the existing broader checks. The repository already has a GitHub Actions CI workflow that runs `npm run check`, `npm run test:unit`, `npm run test:notebook`, and the Electron sandbox/agent suite on Windows and Ubuntu. Preserve and extend that workflow; do not duplicate it blindly.
6. Do not change dependency major versions, persistence formats, agent framework, or public IPC protocol without a migration/compatibility plan.
7. Keep user-visible scope honest. Do not claim competitor parity, sandbox guarantees, benchmark success, or cross-platform support without evidence.
8. At each phase gate, write a short evidence summary: files changed, commands run, pass/fail, known limitations, and next recommendation. Stop at a blocked gate instead of hiding failures behind unrelated changes.

## Phase 0 — Establish the baseline

### Tasks

1. Inspect and record:
   - current Git status/branch and preserve existing changes;
   - CI workflows and their actual commands/OS coverage;
   - current package version versus `CHANGELOG.md`, release configuration, and app-reported version;
   - existing `scripts/eval-agent.mjs`, `evals/`, and test task fixtures;
   - current supported Electron/Node/OS matrix.
2. Run the existing checks (do not edit code to make a failing baseline look green):
   - `npm run check`
   - `npm run test:unit`
   - `npm run test:notebook`
   - `npm test` or the documented Electron test command where the current platform supports it
   - `npm run build`
3. Save exact command output/status to a dated baseline report, separating pre-existing failures from new regressions.
4. Build an evaluation plan for 50–100 repository tasks. Start with a representative small set if authoring all tasks is a separate effort. Include bugs, multi-file features, refactors, failing tests, instruction following, and safe handling of destructive requests.
5. Specify a deterministic task format: clean repo snapshot/commit, prompt, allowed model/provider, timeout/budget, grading script or human rubric, and acceptance criteria. Record task success, tests/regressions, user interventions, cost, elapsed time, and diff-review rating.

### Acceptance gate

- Existing CI commands and current checkout health are documented from actual runs.
- Package/changelog version discrepancy is either corrected or explicitly identified as expected with release evidence.
- Eval task schema, scoring rubric, and reproducibility procedure are documented.
- No product behavior changes are mixed into baseline collection.

## Phase 1 — Close the immediate trust gaps

### 1A. Make renderer sandboxing the default

1. Trace preload behavior, Electron APIs, browser/webview usage, file preview, and plugin iframe paths under `sandbox: true`.
2. Add/update automated smoke coverage for core Code/Home/Notebook interactions with the sandbox enabled.
3. Set renderer sandboxing on by default. If some feature cannot work sandboxed, fix its boundary instead of silently disabling the sandbox. Keep an explicit development-only override only if it is necessary and clearly scoped.
4. Add a regression check that packaged BrowserWindow configuration retains `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.

### 1B. Make credential storage behavior explicit and safe

1. Map every credential write/read path (provider keys, MCP environment/headers, parser and embedding keys) and identify plaintext fallback behavior.
2. Define policy for unavailable OS encryption: prefer refusing persistent secret storage with a clear UI message; if a compatibility fallback is retained, require explicit user opt-in and label the reduced protection.
3. Add migration behavior for existing encrypted/plaintext entries and tests for unavailable keychain, decryption failure, and re-entry.
4. Ensure logs, renderer responses, exports, and crash diagnostics never reveal raw secrets.

### 1C. Tighten command and plugin containment incrementally

1. Inventory subprocess creation, shell execution, plugin runner, lifecycle hooks, browser network calls, and approval paths.
2. Enforce bounded execution time and output for every untrusted subprocess. Add cancellation/kill tests and prove child processes are cleaned up.
3. Add explicit network policy for agent commands/plugins (default policy should be deliberate, user-visible, and testable). Do not break ordinary local coding workflows without a migration path.
4. For supported platforms, isolate plugin/agent child processes using available OS mechanisms; report the actual level of protection per platform. Where full OS sandboxing is unavailable, state the limitation and require trust/approval rather than overclaiming.
5. Add adversarial tests for IPC sender/payload validation, path traversal and symlinks, plugin timeouts/crashes, shell approval bypass, redirects/private network destinations, and secret redaction.

### Acceptance gate

- Sandbox is on in production configuration and covered by runtime/build assertions.
- Secret persistence has no silent plaintext fallback.
- Every untrusted process path has a documented timeout, output bound, cancellation path, and test.
- Security docs accurately describe tested guarantees and remaining gaps.

## Phase 2 — Improve coding results using evidence

### Tasks

1. Implement the eval harness/task schema from Phase 0 and run a baseline across a small set of representative tasks and available providers/models.
2. Ensure each run captures prompt/config/model version, repo state, tool calls, approvals, verification commands/results, final diff, latency, token/cost data, and terminal status without leaking secrets.
3. Grade outcomes with both deterministic checks and human review. A passing test suite alone is not enough for task correctness or patch quality.
4. Categorize failures: missed context, wrong plan, edit failure, shell/test failure, weak repair, context overflow, cancellation/recovery, provider incompatibility, or UI/approval confusion.
5. Fix the highest-frequency and highest-severity failure classes one at a time. Do not make prompt changes based only on anecdotes; preserve eval cases as regression tests.
6. Audit verification command selection so it runs targeted, repo-appropriate checks and reports what it did and did not run.

### Acceptance gate

- Baseline can be reproduced from documented commands and fixed task snapshots.
- Each agent-quality change demonstrates improvement on target failure classes without unacceptable regressions on the full suite.
- Report success rate, regression rate, time/cost, and intervention count; do not claim parity from one aggregate score.

## Phase 3 — Make task lifecycle durable and clear

### Tasks

1. Specify a versioned run event/state protocol with explicit states (queued, preparing, planning, executing, verifying, awaiting approval, repairing, completed, failed, cancelled).
2. Define invariants for one run: stable ID, ordered events, terminal state exactly once, idempotent persistence, cancellation propagation, and clear ownership of session/worktree.
3. Persist enough journal state to recover after application restart without replaying dangerous side effects. Resume only at safe boundaries; ask for approval again when required.
4. Ensure run checkpoints distinguish agent changes from user changes and restore behavior is tested with interrupted writes, app restart, and worktree conflicts.
5. Provide clear final summaries: changed files, verification commands/results, approvals, unresolved issues, and rollback action.
6. Add end-to-end tests for concurrent sessions, cancellation during model/tool/verification phases, crash/restart, and event ordering.

### Acceptance gate

- Run lifecycle invariants are documented and tested.
- Restart/cancel tests prove no duplicate dangerous actions and no loss of user-authored changes.
- UI always shows truthful status and terminal outcomes.

### Code-mode compaction continuity slice (implemented; live evaluation remains)

At context-pressure relaunch, append a bounded recovery brief derived from the Code task journal after trimming transcript history. Preserve the original request/constraints, current phase and plan, next unfinished step, changed files, latest supervisor verification outcomes/diagnostics, and recent completed actions. Keep tool-call/result pairs intact and label saved excerpts as data that must be re-checked. Upgrade existing version 1 journals on load. Regression coverage verifies the brief survives actual transcript trimming, stays within budget, and does not orphan tool results. Run repeated long Code tasks with early critical facts and forced context pressure before claiming task-quality gains.

## Phase 4 — Modularize the runtime without a rewrite

### Tasks

1. Extract IPC handler registration from `electron/main.ts` by domain, keeping a small bootstrap and explicit dependency injection.
2. Define typed, schema-validated IPC request/response contracts. Keep renderer-facing capabilities narrow; never let renderer-supplied project IDs, file paths, permissions, or plugin identity bypass main-process validation.
3. Separate Code run orchestration from Home and Notebook paths where it reduces shared mutable state, with shared services passed explicitly.
4. Establish module ownership for session state, cancellation, provider/model configuration, and event emission.
5. Extract one bounded area per change and run the same cross-platform CI. Avoid changing data formats while moving code.

### Acceptance gate

- No observable feature changes from refactoring.
- IPC contract tests cover valid/invalid inputs and unauthorized senders.
- Existing CI remains green and targeted end-to-end flows preserve behavior.

## Phase 5 — First-class CLI, then IDE integration

### CLI tasks

1. Audit `scripts/agent-cli.mjs`; document current behavior and missing pieces before extending it.
2. Design stable commands for install/help/version/doctor, interactive run, one-shot prompt, JSON/streaming output, explicit model/mode, session list/resume, cancellation, and approval handling.
3. Return meaningful exit codes and machine-readable final status; keep secrets out of command history and logs.
4. Reuse the same run protocol/services as desktop. Add integration tests that compare CLI and desktop behavior on the same fixture task.
5. Publish install/update instructions for supported OSes and test them in CI.

### IDE tasks

1. Build a minimal VS Code extension only after the run protocol and CLI are stable.
2. Support selected/open-file context, task start/stream/stop, approval prompts, inline diff review, and safe handoff to the desktop session.
3. Keep workspace trust and extension permissions explicit; do not duplicate agent orchestration in the extension.
4. Add extension tests for reconnect, cancellation, stale session events, and workspace trust.

### Acceptance gate

- A user can start a task in CLI, continue/review in desktop, and preserve one session and diff state.
- IDE feature is an integration surface to the shared runtime, not a forked agent implementation.

## Phase 6 — Parallel tasks and remote work only after local reliability

### Tasks

1. Add a task queue with explicit user-visible ownership, status, logs, pause/steer/cancel, and resource limits.
2. Allocate one isolated worktree per mutating task. Add conflict detection and an explicit review/merge step; never auto-merge competing changes.
3. Start with two concurrent tasks; gather throughput and conflict metrics before raising limits.
4. Add scheduled/background runs only with explicit configuration, visible logs, secure credential handling, and an easy disable path.
5. Consider remote execution environments only after local security, recovery, and task serialization are stable. Define reproducible setup, network policy, secret injection, cleanup, and diff-only return.

### Acceptance gate

- Parallel work increases accepted tasks per unit time without increasing lost work, merge conflicts, review defects, or permission incidents.
- Every task is independently cancellable and recoverable; task results remain isolated until user review.

## Phase 7 — Preserve and connect Nexus differentiation

1. Improve Notebook with measured citation precision/coverage, ingestion success, groundedness, and user correction metrics.
2. Validate generated DOCX/PPTX/XLSX/PDF by rendering and opening outputs, not only checking file signatures.
3. Add a traceable path from a Notebook source passage/spec/bug report to a Code task, preserving citation provenance and user approval.
4. Keep multi-provider support, but define a tested provider compatibility matrix and a simple recommended default.
5. Do not grow marketplace counts or UI options unless usage shows that they improve task completion.

### Home-mode long-task continuity slice (implemented; further evaluation remains)

Home keeps the shared automatic run-context compaction. For long tasks, compacted conversation text is not enough to reliably resume after interruption, so maintain a separate bounded, versioned Home task summary containing the goal, phase, recent completed tool actions, and output paths. Include it when a context-pressure relaunch occurs, and restore it for an explicit continuation of an unfinished task. Treat saved tool excerpts as observations, not instructions; re-check time-sensitive research and validate outputs. Keep unrelated new Home requests isolated from unfinished task journals. Add regression coverage for compaction/relaunch, interruption, explicit continuation, journal migration, and long-task model runs before claiming measured task-quality gains.

## Release gate (required for every phase)

Before declaring a phase complete:

1. Run `npm run check`.
2. Run the relevant tests, then the full existing CI set: `npm run test:unit`, `npm run test:notebook`, and the Electron sandbox/agent suite where supported.
3. Run `npm run build`; perform packaged smoke testing for every claimed platform before release.
4. Review `git diff` for unrelated changes, secrets, generated files, and unintended persistence/API changes.
5. Update docs, changelog, tests, and version metadata together when user-visible behavior or release status changes.
6. Report evidence and limitations. A CI pass is necessary but not proof of competitor parity; retain eval and user-acceptance evidence separately.

## Current-repo correction to the competitive report

The repository already contains a GitHub Actions CI workflow running typecheck, unit tests, notebook tests, and the Electron sandbox/agent suite on Windows and Ubuntu. The coding agent should first run and assess this pipeline, then add missing **packaged smoke, release/version consistency, signing, and runtime security** gates. It should not describe CI as absent.

## First concrete work package

Start with a read-only baseline, then make one independently reviewable change:

1. Capture current Git status and leave all pre-existing edits untouched.
2. Run the existing CI commands and package build; save results and triage failures.
3. Inspect the Electron sandbox canary and run the full app with sandbox enabled.
4. If it passes supported workflows, make sandboxing the default and add a regression test; if it fails, report the exact incompatible boundary and fix that boundary before proceeding.
5. Map credential storage paths and propose the fallback/migration behavior before changing stored data semantics.

Do not begin CLI, IDE, cloud, or parallel-task feature work until the Phase 1 safety gate and Phase 2 eval baseline are established.
