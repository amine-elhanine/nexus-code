---
description: Initialize project memory — analyze the repo and write/update AGENTS.md
argument-hint: [optional focus areas]
---

# Initialize Project Memory

**Input (optional focus)**: $ARGUMENTS

You are generating the durable project-instruction file (AGENTS.md) for this repository — the memory that every future agent task in this repo will read before doing anything. Work autonomously and end with the file written.

## Phase 1 — ORIENT (read-only, at most 6 calls)

- Read the manifest files: `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml` / `pom.xml` / `build.gradle*` / `pubspec.yaml` — whichever exist.
- Read the top-level directory listing (never the repo root recursively — no `node_modules`/`dist` walks).
- Read `README.md` and any `CONTRIBUTING.md` / `docs/` entry points if present.
- Read build/CI configs: `tsconfig*.json`, `.github/workflows/*`, `Makefile`, `CMakeLists.txt` — whichever exist.
- If AGENTS.md or CLAUDE.md already exists, READ IT — you are updating, not blind-overwriting.
- If the request names focus areas ($ARGUMENTS), spend extra exploration there.

## Phase 2 — WRITE AGENTS.md

Write `AGENTS.md` at the repository root with EXACTLY these sections:

```markdown
# AGENTS.md — <project name>

## What this is
2–3 sentences: purpose, stack, current state.

## Commands
- Build: <exact command that works>
- Dev: <exact command>
- Test: <exact command + any required env vars or setup>
- Lint/typecheck: <exact command>
Only commands verified against the manifests/configs you read. Do not guess.

## Architecture
Where the important code lives, 5–12 bullets: entry points, main modules, how they connect, where new features go.

## Conventions
Naming, file layout, test style, commit style — only what is ACTUALLY consistent in the codebase, not aspirations.

## Gotchas
Known traps: required env vars, slow tests, generated dirs never to edit, version quirks. Empty section is fine.

## Do not
Out-of-bounds areas: generated files, vendored code, deployment secrets.
```

Rules:
- Under 120 lines total. This file is injected into every future run's system prompt — density beats completeness.
- Every command must be copy-pasteable and verified against what you read. If a command cannot be verified from configs, mark it "(unverified)".
- If AGENTS.md already exists: keep its correct, still-true content; fix stale facts (old paths, renamed commands); fill empty sections from your analysis. Never delete user-written sections wholesale.
- If the repo already has CLAUDE.md (not AGENTS.md), port its still-accurate content into AGENTS.md.

## Phase 3 — VERIFY + REPORT

- Re-read the written AGENTS.md and sanity-check every command against the manifests.
- Then record the most important 3–5 discoveries in durable memory with the project_memory tool (action='remember', category='fact' or 'context') — e.g. the verified build/test commands. Do not duplicate what AGENTS.md already states verbatim.
- End by reporting: file written, its line count, and one thing the user should confirm or correct.
