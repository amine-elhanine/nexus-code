# Changelog

All notable changes to Nexus are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.4.5] - 2026-10-12

Nexus 0.4.5 brings a brand new Plugin Marketplace, native interactive charts in Home mode, smarter agent loops that avoid repeating searches, citation highlights in Notebook mode, and a cleaner chat progress feed.

### New Features

#### Plugin Marketplace
- **Redesigned In-App Store**: Browse and manage extensions from a clean store view in Settings, featuring live search, status filters (Installed, Available, Dev), and Grid vs. List views.
- **Capability Filters**: Filter extensions by what they add to your workspace, including Skills, Specialist Subagents, Slash Commands, Coding Rules, and Event Hooks.
- **Plugin Inspector**: View full details, author information, descriptions, and installed files before adding an extension.
- **Bundled Flagship Suites**: Includes the Engineering Suite (standards and workflows for TypeScript, Python, React, Rust, Go, Vue, and Docker) and the Research Studio (deep research, evaluation tools, and office document generators).
- **Custom Feeds and Local Development**: Connect private registry feeds or link local developer folders to test custom plugins instantly.

#### Interactive Charts in Home Mode
- **Inline Visualizations**: Ask the assistant for visual insights and receive interactive charts rendered directly in chat, including bar charts, line graphs, pie charts, area charts, scatter plots, radar charts, and diagrams.
- **Theme-Aware Styling**: Charts automatically adapt their colors and contrast to match your selected theme.
- **Automatic Visual Embedding**: If the agent creates charts or chart images during data analysis, they are automatically placed directly in your chat response so you can see the results immediately.
- **Verified Deliverables**: Strengthened verification to ensure Word, PowerPoint, Excel, and PDF files are generated cleanly without file corruption.

#### Grounded Research Notebook
- **Verified Citations**: Clickable citation tags open the exact evidence source and highlight relevant passages in the side panel.
- **Strict Accuracy Gate**: The model refuses to guess if your uploaded documents do not contain enough evidence to answer a question.
- **Interactive Study Tools**: Generate interactive flashcards, multiple-choice quizzes, mind maps with zoom and pan, and executive summaries from your sources.
- **Enhanced Network Security**: Built-in protection blocks unauthorized network requests and private IP access during web ingestion.

### Improvements & Fixes

#### Agent Performance and Stability
- **Smart Web Loop Prevention**: If a search query or webpage returns unhelpful results, the agent now redirects itself to alternative sources instead of repeatedly retrying the same page or stopping the task.
- **Research Quotas**: Balanced research budgets prevent the assistant from spending too much time browsing when you need quick answers.
- **Accurate Token Tracking**: Token counts and cost calculations are now accurately recorded even if a run is cancelled or interrupted.
- **Cross-Platform File Handling**: Improved file path resolution on Windows systems to avoid case-sensitivity and backslash issues.

#### User Interface
- **Redesigned Progress Stepper**: A cleaner, connected activity timeline showing what the agent is currently reading, running, or editing in real time.
- **Expandable Output Cards**: Terminal outputs, command logs, and file previews can now be expanded or copied to the clipboard with one click.
- **Polished Visual Themes**: Improved contrast and element styling across all 10 color themes.

---

## [0.4.4] - 2026-10-09

### Improvements
- Added preview support for Markdown chart blocks in Home mode.
- Improved asynchronous document parsing performance in Notebook mode.
- Fixed cancellation handling when the agent is waiting on rate limit retries.
- Resolved memory deduplication issues in Home mode.
- Fixed code editor responsiveness when resizing sidebars.

---

## [0.4.3] - 2026-10-05

### Initial Baseline
- Unified desktop experience combining Code mode, Home assistant mode, and Notebook research mode.
- Code intelligence supporting Language Server Protocol (LSP) across TypeScript, Python, Go, Rust, and C++.
- Git worktree isolation and multi-level undo checkpoints.
- Out-of-process terminal host and in-app code editor.
- Encrypted local credential storage with zero telemetry.
