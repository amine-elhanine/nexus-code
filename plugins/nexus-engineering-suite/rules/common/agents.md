# Agent Orchestration

## Delegation

Delegate focused sub-tasks with the `delegate_task` tool. The role parameter is
free-form; the full catalog of available specialist roles (name + purpose) is
listed in your system instructions under "SPECIALIST SUBAGENTS" — consult it
instead of guessing role names.

Core roles available in every project:

| Role | Purpose | When to Use |
|------|---------|-------------|
| architect | System design | Architectural decisions |
| code-reviewer | Code review | After writing code |
| security-reviewer | Security analysis | Before commits |
| tdd-guide | Test-driven development | New features, bug fixes |
| build-error-resolver | Fix build errors | When build fails |
| refactor-cleaner | Dead code cleanup | Code maintenance |
| database-reviewer | Schema/query review | Database changes |
| researcher | Codebase exploration | Multi-file investigation |
| tester | Test execution and diagnosis | Failing suites, reproduction |
| coder | Focused implementation | Isolated subtasks |

Language specialists (e.g. rust-reviewer, python-reviewer, react-reviewer) and
domain reviewers from the catalog apply when the relevant stack is present.

## When to Delegate

Delegate proactively — no user prompt needed:
1. Complex feature requests - Use **architect** for the design
2. Code just written/modified - Use **code-reviewer**
3. Bug fix or new feature - Use **tdd-guide**
4. Build or compile failure - Use **build-error-resolver**

Never delegate simple single-file edits, lookups, or Q&A — do them directly.

## Parallel Task Execution

Use parallel delegation for INDEPENDENT read-only operations:

```markdown
# GOOD: Parallel execution of read-only specialists
Launch 3 reviewers in parallel:
1. code-reviewer: review of auth module changes
2. security-reviewer: audit of token handling
3. database-reviewer: check migration scripts

# BAD: Sequential when unnecessary
First reviewer 1, then reviewer 2, then reviewer 3
```

Write-capable roles (coder, tdd-guide, build-error-resolver, refactor-cleaner)
MUST run one at a time — concurrent edits to one workspace corrupt each other.

## Delegation Completion Contract

Applies to every delegation:

1. **Your final message IS the deliverable.** Never end with "review is
   running" — a delegated task is not a completed task.
2. **If you delegate, you own collection.** Wait for results, integrate them,
   then report. Fire-and-forget delegation is forbidden.
3. **Decompose only when the work cannot fit in one context.** Do not
   re-delegate a task already sized for a single agent — subagents cannot
   spawn further subagents.

## Multi-Perspective Analysis

For complex problems, use the reviewer roles as split perspectives:
- code-reviewer for correctness and maintainability
- security-reviewer for injection, secrets, and input validation
- database-reviewer for data integrity and query performance
