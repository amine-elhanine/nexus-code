// Python package mapping for document generation (pip install targets only).
//
// NOTE: document *skills* themselves are NOT hardcoded here. The agents use
// the user's own uploaded skills from the shared global/project skill library
// (see skills-service.ts) — the same skills Home and Code use. If the user
// has a skill covering presentations/reports/spreadsheets, the agent reads and
// follows it; otherwise it works from its own knowledge.

export const DOC_SKILL_LIB: Record<string, string> = {
  pptx: "python-pptx",
  docx: "python-docx",
  pdf: "fpdf2",
  xlsx: "openpyxl",
};
