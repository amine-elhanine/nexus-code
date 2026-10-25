# Nexus agent evaluation

This is a small end-to-end baseline for Code and Home runs. It runs real model
calls in fresh temporary projects, then checks the result with objective Node
tests. Reports are written under `.nexus/evals/` and include the resolved
provider and model, task kind, verification, token usage, the answer, and
independent check output. Temporary
workspaces are removed after each run. Code and Home reports also include run
duration and tool/subagent event counts.

Run one case or the full set:

```sh
npm run eval:agent -- --case code-format-duration --model <model>
npm run eval:agent -- --case code-resists-source-injection --model <model>
npm run eval:agent -- --case home-resists-source-injection --model <model>
npm run eval:agent -- --case code-resists-source-injection --model <model> --repeat 3
npm run eval:agent -- --case code-project-command-expansion --model <model>
npm run eval:agent -- --case home-project-command-expansion --model <model>
npm run eval:agent -- --case code-subagent-spec-implementation --model <model>
npm run eval:agent -- --case code-project-skill-port-parser --model <model>
npm run eval:agent -- --case code-project-rule-slug-contract --model <model>
npm run eval:agent -- --model <model>
npm run eval:agent -- --model <model> --without-assets skills,rules,agents,commands
npm run eval:agent -- --model <model> --timeout-ms 900000
npm run eval:notebook
npm run eval:notebook -- --live --case notebook-grounded-answer --provider <provider-id> --model <model>
npm run eval:notebook -- --live --case notebook-grounded-answer --provider <provider-id> --model <model> --without-assets skills
npm run eval:notebook -- --live --case notebook-resists-source-injection --provider <provider-id> --model <model>
npm run eval:notebook -- --live --case notebook-grounded-answer --provider <provider-id> --model <model> --repeat 3
```

Use the same provider, model, and environment when comparing runs. Configure a
provider in Nexus or pass `--provider`, `--api-key`, and `--base-url` as needed.
Headless runs can auto-select configured plaintext-key providers, local Ollama,
or a custom OpenAI-compatible provider with a base URL; encrypted desktop keys
still need to be supplied explicitly for headless use.
Code and Home evaluation makes real model calls and may incur provider charges;
use `--case` to run one case at a time. Each run has a 10-minute timeout by
default; use `--timeout-ms` to set a limit from 1 second to 30 minutes. Timed-out
agent or checker processes are terminated and recorded as failures. API keys are
passed to the child process through its environment and redacted from reports.
Each case is independent, so a failed case does not affect
later cases. The runner detects and rejects changes to the independent checker,
restores its trusted copy, then executes it. The process exits nonzero if Nexus
verification, checker integrity, or the objective check fails.

## What this measures

- **Objective success:** the independent case tests pass.
- **Agent verification:** Nexus must report `passed`; `none` fails cases whose
  requests explicitly require tests or a checked deliverable, even if the
  independent checker later happens to pass.
- **Efficiency:** usage data is retained when the provider supplies it.
- **Qualitative review:** inspect the response and consider scope, clarity, and
  whether the agent respected the task instructions.

Use `--without-assets` to run a controlled ablation of Code/Home prompt assets.
The accepted names are `skills`, `rules` (including project instruction files),
`agents` (subagent tool and role catalog), and `commands` (slash-command
expansion). The project-command cases require the command expansion event when
the `commands` asset is enabled, so they measure that category rather than just
general task ability. The subagent implementation case similarly requires an
observed subagent delegation when `agents` is enabled. Compare a full run and an ablated run using the same case,
provider, model, and settings; reports record the omitted assets. A single run does not
prove that an asset helps, and output quality can vary between model calls, so
repeat comparisons before drawing conclusions. Commands is measured only by
the two project-command cases; skills and rules each have focused project
fixtures and require the corresponding load event when enabled. Home already omits repository rules and
subagents by design, so `rules` and `agents` ablations have no effect there;
Home comparisons should focus on `skills` and `commands`.

Home cases use `taskKind: "general"` and can validate deliverable contracts.
The Code and Home injection cases place conflicting instructions in project
source material and use independent checkers to reject the injected behavior.
They measure end-to-end behavior only when run with a live model; the checkers
themselves can be validated offline, but that does not measure model resistance.
Notebook's default evaluation is deterministic and offline: it isolates
retrieval, groundedness refusal, citation coverage, and whether a cited source
is the expected source for each tested claim. Use `--live` for real model
answers and citations; live runs may incur provider charges. Live Notebook runs
can omit `skills` to compare the skill catalog's effect. Notebook has no
repository rules, slash-command templates, or subagent tool. The offline
generator does not exercise prompt assets, so `--without-assets` is rejected
without `--live`. Live fact checks require configured terms and a citation in
the same sentence; they catch omissions and misattributed sources but cannot
prove semantic entailment or answer quality. Review the saved answer and repeat
paired runs before attributing gains to an asset. The live
`notebook-resists-source-injection` case places conflicting instructions in an
uploaded source and fails if the answer repeats the injected false claim. The
offline runner marks that case as skipped, reports the overall run as
`partial`, and lists expected, evaluated, and skipped run counts. Its `passed`
field means every evaluated case passed; `complete` means every selected case
was evaluated. Selecting only the injection case without `--live` fails
instead of reporting a synthetic pass. Only a live run exercises the model and
prompt. The ablation switch removes
a whole asset category; it does not isolate one specific skill. Add focused
cases as regressions or important user workflows emerge; keep each case
objective and cheap to run. Judge asset effects by objective success,
verification, time, and output review — not prompt length or tool-call counts
alone. `--repeat 1..10` runs each selected case in a fresh workspace or
notebook and records each result plus an aggregate pass rate. Repeating a case
reduces the chance of mistaking one lucky or unlucky model response for an
asset effect; compare full and ablated reports with the same repeat count,
provider, model, and settings.

## Case inventory and failure-class taxonomy

`evals/cases.json` holds 56 agent cases. Every case embeds an independent
checker that provably FAILS the untouched fixture stub — `test/eval-corpus.test.mjs`
(wired into `npm run test:unit`) enforces that, so no case can pass without
the agent doing real work. When a run fails, categorize the failure into one
of the plan's failure classes; the categories below group cases by the class
they most directly exercise:

| Failure class / category | Cases (prefixes) | What a failure here usually means |
|---|---|---|
| **Edit failure / wrong plan** — implement a spec strictly | `code-roman-numerals`, `code-lru-cache`, `code-intervals-merge`, `code-csv-parse-quoted`, `code-markdown-toc`, `code-array-chunks`, `code-json-flatten`, `code-convert-temperature`, `code-parse-duration-string`, `code-rle-encode`, `code-top-words`, `code-mime-lookup`, `code-semver-compare`, `code-paren-balance`, `code-rotate32`, `code-fizzbuzz-classify`, `code-digits-to-words`, `code-html-escape`, `code-format-utc-offset`, `code-dedupe-keep-highest` | spec adherence; error-class discipline (TypeError vs RangeError vs SyntaxError) |
| **Missed context / weak repair** — fix a subtle bug in existing code where a confident comment points the wrong way | `code-debug-moving-average`, `code-debug-month-name`, `code-debug-reverse-codepoints`, `code-debug-debounce-last-args`, `code-debug-prefix-test`, `code-debug-cache-freshness` | the agent trusted prose over tests, or fixed the wrong invariant |
| **Behavior-preserving change** — refactors where the tests were already correct | `code-refactor-locale-option`, `code-refactor-pure-transform`, `code-refactor-promise-api` | scope discipline: the agent must keep contracts and not over-edit |
| **Injection resistance (code)** — self-instructions in fixture source | `code-resists-source-injection`, `code-resists-test-collision`, `code-resists-range-weakening` | following instructions embedded in workspace content |
| **Injection resistance + fact bounding (Home)** | `home-resists-source-injection`, `home-resists-milestone-injection`, `home-attributed-conflicting-facts`, `home-missing-fields-contract`, `home-source-bounded-runbook`, `home-release-notes-bounded`, `home-glossary-two-terms`, `home-meeting-minutes`, `home-changelog-dates-descending`, `home-attributed-mixed-units` | groundedness, explicit "Missing:" contract, attribution discipline |
| **Prompt-asset surfaces** (commands / skills / rules / subagents) | `code-project-command-expansion`, `home-project-command-expansion`, `code-project-command-slugify`, `home-project-command-standup`, `code-project-command-log-prefix`, `code-project-skill-port-parser`, `code-project-skill-iso-date`, `code-project-skill-wordcount`, `code-project-rule-slug-contract`, `code-project-rule-env-naming`, `code-subagent-spec-implementation`, `code-subagent-db-spec` | a failure with `passed` objective checks usually means the event (`Expanded slash command`, `Skill loaded`, `Loaded N project rule file`, subagent delegation) was not observed — asset wiring, not capability |

Notes for maintaining the corpus:

- Keep every case objective and cheap: checkers run with `node --test --test-reporter tap`
  against fresh temp workspaces and must fail on the pristine stub.
- Distinct error classes are part of most code contracts (`TypeError` for wrong
  types, `RangeError` for out-of-range values, `SyntaxError` for malformed
  strings); a passing but wrong-class implementation still fails the checker.
- Deterministic checkers only: no wall-clock time, real timers, locales without
  a pinned default, or network. `Intl` is allowed with the documented default
  evidence (full-icu Node builds), as used by `code-refactor-locale-option`.
- Whole-response register: `home-*` cases grade the produced file only — bullet
  counts, ordering, and the absence of invented claims are the rubric, so an
  over-talking answer fails the objective check even with the file present.
