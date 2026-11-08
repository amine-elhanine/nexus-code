# One-off: extend widget-blocks.ts with card/step smart-UI elements.
p = 'src/utils/widget-blocks.ts'
s = open(p, encoding='utf8').read()

# 1. Types
old = '''export type WidgetSpec = {
  title: string;
  inputs: WidgetInput[];
  stats: WidgetStat[];
  gauges: WidgetGauge[];
  charts: WidgetChart[];
  tables: WidgetTable[];
  actions: WidgetAction[];
  note: string;
};'''
assert old in s
new = '''export type WidgetCard = { title: string; badge?: string; body: string };
export type WidgetStep = { badge: string; title: string; detail?: string };

export type WidgetSpec = {
  title: string;
  inputs: WidgetInput[];
  stats: WidgetStat[];
  gauges: WidgetGauge[];
  charts: WidgetChart[];
  tables: WidgetTable[];
  actions: WidgetAction[];
  /** Structured comparison / pros-cons / feature cards (grid layout). */
  cards: WidgetCard[];
  /** Ordered process stepper (phase badge, title, description). */
  steps: WidgetStep[];
  note: string;
};'''
s = s.replace(old, new, 1)

# 2. Caps + regexes
old2 = '''const TITLE_RE = /^title\\s+"([\\s\\S]*)"$/i;'''
assert old2 in s
new2 = '''const MAX_CARDS = 6;
const MAX_STEPS = 8;
const CARD_RE = /^card\\s+"([^"]*)"(?:\\s+"([^"]*)")?\\s+"([^"]*)"$/i;
const STEP_RE = /^step\\s+"([^"]*)"\\s+"([^"]*)"(?:\\s+"([^"]*)")?$/i;
const TITLE_RE = /^title\\s+"([\\s\\S]*)"$/i;'''
s = s.replace(old2, new2, 1)

# 3. parseWidget init
old3 = '''  const spec: WidgetSpec = { title: "", inputs: [], stats: [], gauges: [], charts: [], tables: [], actions: [], note: "" };'''
assert old3 in s
new3 = '''  const spec: WidgetSpec = { title: "", inputs: [], stats: [], gauges: [], charts: [], tables: [], actions: [], cards: [], steps: [], note: "" };'''
s = s.replace(old3, new3, 1)

# 4. Parse card/step lines after the NOTE_RE block
old4 = '''    if ((match = line.match(NOTE_RE))) {
      spec.note = match[1];
      continue;
    }'''
assert old4 in s
new4 = old4 + '''
    if ((match = line.match(CARD_RE))) {
      if (spec.cards.length >= MAX_CARDS) continue;
      spec.cards.push({ title: match[1].slice(0, 80), badge: match[2]?.slice(0, 40) || undefined, body: match[3].slice(0, 400) });
      continue;
    }
    if ((match = line.match(STEP_RE))) {
      if (spec.steps.length >= MAX_STEPS) continue;
      spec.steps.push({ badge: match[1].slice(0, 40), title: match[2].slice(0, 100), detail: match[3]?.slice(0, 400) || undefined });
      continue;
    }'''
s = s.replace(old4, new4, 1)

# 5. Validation: cards/steps count as widget content
old5 = '''    !spec.inputs.length && !spec.stats.length && !spec.gauges.length &&
    !spec.charts.length && !spec.tables.length && !spec.actions.length
  ) {'''
assert old5 in s
new5 = '''    !spec.inputs.length && !spec.stats.length && !spec.gauges.length &&
    !spec.charts.length && !spec.tables.length && !spec.actions.length &&
    !spec.cards.length && !spec.steps.length
  ) {'''
s = s.replace(old5, new5, 1)

open(p, 'w', encoding='utf8', newline='\n').write(s)
print("widget-blocks extended")
