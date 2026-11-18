// Shared compact prompt modules and lightweight task-type classifiers used
// by agent-prompt.ts and notebook-rag.ts. Keeping task-specific syntax (charts,
// widgets, HTML visuals, code workflows) modular prevents dumping hundreds of
// irrelevant lines into every prompt while preserving exact syntax when needed.
import type { AgentMode, HomeTaskContract } from "./agent-types.js";
import type { TaskComplexity } from "./task-routing.js";

export type CodeTaskType =
  | "plan"
  | "qa_lookup"
  | "review_audit"
  | "new_project"
  | "bugfix"
  | "feature_edit";

export type HomeTaskType =
  | "greeting"
  | "edit_file"
  | "deliverable"
  | "interactive_widget"
  | "html_visual"
  | "chart_visual"
  | "research"
  | "chat_qa";

const WIDGET_INTENT_PATTERN =
  /\b(widget|calculator|converter|simulator|estimator|what[- ]if|interactive\s+tool|slider|amortization|mortgage|roi|compound\s+interest|grade\s+(?:needed|calculator)|budget\s+planner|threshold|sensitivity)\b/i;

const HTML_VISUAL_INTENT_PATTERN =
  /\b(animation|animate|animated|simulation|simulate|physics|state\s+machine|step[- ]by[- ]step\s+visual|algorithm\s+(?:walkthrough|visual)|interactive\s+(?:diagram|visual|demo|canvas|svg)|visual\s+explainer)\b/i;

const CHART_VISUAL_INTENT_PATTERN =
  /\b(chart|charts|graph|graphs|plot|plots|histogram|scatter|radar|pie|donut|bar\s+chart|line\s+chart|area\s+chart|mermaid|flowchart|sequence\s+diagram|timeline|visualize|visuali[sz]e|visual|diagram|trend|trends|forecast|breakdown|distribution|share|market\s+share|benchmark|versus|\bvs\.?\b)\b/i;

const REVIEW_AUDIT_PATTERN =
  /^\s*(?:review|audit|inspect|check|evaluate|analyze|analyse|critique|assess)\b/i;

const CODE_MUTATION_VERB_PATTERN =
  /\b(fix|implement|add|change|refactor|update|create|build|write|edit|modify|remove|delete|rename|migrate|patch|resolve|solve)\b/i;

const CODE_BUG_PATTERN =
  /\b(bug|error|exception|crash|failing|fails|failed|broken|doesn'?t\s+work|not\s+working|regression|issue|fix|debug|trace(?:back)?)\b/i;

export function wantsInteractiveWidget(text: string): boolean {
  return WIDGET_INTENT_PATTERN.test(text || "");
}

export function wantsHtmlVisual(text: string): boolean {
  return HTML_VISUAL_INTENT_PATTERN.test(text || "");
}

export function wantsChartOrDiagram(text: string): boolean {
  return CHART_VISUAL_INTENT_PATTERN.test(text || "");
}

export function classifyCodeTask(params: {
  request?: string;
  mode: AgentMode;
  isNewProject?: boolean;
  complexity?: TaskComplexity;
}): CodeTaskType {
  if (params.mode === "plan") return "plan";
  const text = (params.request || "").trim();
  if (params.isNewProject) return "new_project";
  if (text && REVIEW_AUDIT_PATTERN.test(text) && !CODE_MUTATION_VERB_PATTERN.test(text)) {
    return "review_audit";
  }
  if (params.complexity === "simple" && !CODE_MUTATION_VERB_PATTERN.test(text)) {
    return "qa_lookup";
  }
  if (text && CODE_BUG_PATTERN.test(text)) return "bugfix";
  return "feature_edit";
}

export function classifyHomeTask(params: {
  request?: string;
  contract?: HomeTaskContract | null;
  isGreeting?: boolean;
  isEdit?: boolean;
}): HomeTaskType {
  const text = (params.request || "").trim();
  if (params.isGreeting) return "greeting";
  if (params.isEdit) return "edit_file";
  if (params.contract?.expectsOutput && (params.contract.expectedFormats.length > 0)) {
    return "deliverable";
  }
  if (wantsInteractiveWidget(text)) return "interactive_widget";
  if (wantsHtmlVisual(text)) return "html_visual";
  if (wantsChartOrDiagram(text)) return "chart_visual";
  if (params.contract?.needsResearch) return "research";
  return "chat_qa";
}

/** Compact native chart, diagram & media grammar (shared between Home and Notebook). */
export const COMPACT_CHART_GRAMMAR = `Inline visuals (enrich comparisons, trends, processes, hierarchies, timelines, entities, or architectures with native inline visuals instead of text-only walls or ASCII art; ground all values in sources; never save charts as .md files):
- Flows/timelines/hierarchies: \`\`\`mermaid (flowchart TD / sequenceDiagram / timeline / pie / xychart-beta)
- Bars (\`\`\`bar or \`\`\`hbar for long labels): one statement per line: title "..." / y-axis "..." / optional series "2024" "2025" & stacked true / bar "Label" 10 20
- Trends (\`\`\`line or \`\`\`area): title "..." / x-axis "..." / y-axis "..." / point "Jan" 120
- Shares (\`\`\`pie or \`\`\`donut): title "..." / slice "Name" 65
- Scatter/Radar: \`\`\`scatter (x-axis "L" min max, y-axis "L" min max, point "Name" x y) | \`\`\`radar (max 100, axis "Dim" 90)
- Interactive/Images/Video: use \`\`\`visual for self-contained HTML/CSS/JS explainers (start with <!-- title: ... -->), \`\`\`widget for live calculators/sliders, generate_image for bespoke illustrations (![Caption](file.png)), web_image_search for 2-4 exact entity photos, or web_video_search for 1-3 relevant videos.`;

/** Minimal visual grammar for small/local models on Home chat/research answers. */
export const COMPACT_VISUAL_GUIDE_SMALL = `Inline visuals (use when comparing numbers or explaining processes; never use ASCII art or save charts to .md files):
- Process/flow: \`\`\`mermaid (flowchart TD / sequenceDiagram / timeline)
- Data charts (one item per line): \`\`\`bar (bar "Label" 10) | \`\`\`line (point "Jan" 120) | \`\`\`pie (slice "Name" 65)
- Real photos/custom art: web_image_search or generate_image (embed ![Caption](file.png)).`;

/** Compact interactive calculator/simulator widget grammar (shared between Home and Notebook). */
export const COMPACT_WIDGET_GRAMMAR = `Interactive \`\`\`widget fence (ONE live mini-tool whose inputs recompute stats, gauges, tables & charts):
Example:
\`\`\`widget
title "Calculator"
input amount "Amount ($)" slider 100 10000 1000 step 100
input rate "Rate (%)" select 5 3 5 7
input bonus "Include bonus" toggle off
stat "Projected" formula "amount * (1 + rate/100) + bonus*50" prefix "$" decimals 2 warn-above 5000
gauge "Target %" formula "amount / 10000 * 100" max "100" suffix "%"
table "Comparison"
columns "Scenario" "Result"
row "Low" "amount * 1.03"
action ask "Explain sensitivity" text "Analyze results at amount={amount} and rate={rate}%."
\`\`\`
Grammar: 2-6 inputs (slider min max def [step n] | number def [min a] [max b] | select def opt1 opt2 | toggle on|off -> 1/0); 1-5 stat/gauge (optional prefix/suffix/decimals, when "<expr>", warn-above/bad-above/warn-below/bad-below n); 0-2 charts (chart bar|line|area|pie|donut "T", series "S", point "L" formula "<expr>"); 0-1 table; 0-2 actions (ask|copy). Single-line formulas <300 chars referencing INPUT names: + - * / % ^, and/or/not, min max abs round floor ceil sqrt pow ln log log2 exp clamp sign between sum avg trig if(c,a,b), pmt(r,n,pv), fv(r,n,pmt[,pv]), pi e.`;

/** Compact sandboxed HTML/CSS/JS visual explainer grammar. */
export const COMPACT_HTML_VISUAL_GRAMMAR = `Interactive \`\`\`visual fence (for custom animations, simulations, step-by-step algorithm/SVG/Canvas explainers):
- Self-contained HTML + <style> + <script> ONLY (NO external CDNs, <script src>, <link>, or fetch()).
- Start with <!-- title: Short Title -->; use theme CSS vars (--bg, --panel, --surface, --text, --muted, --border, --accent); responsive width: 100%, height ~220-560px.`;
