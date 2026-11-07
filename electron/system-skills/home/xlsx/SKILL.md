---
name: xlsx
description: Build formatted Microsoft Excel spreadsheets (.xlsx) with openpyxl in a single efficient pass. Use when the user asks for spreadsheets, financial models, tables, or data sheets.
---

# xlsx — Excel Spreadsheet Generation


## Fast Path First (Preferred)
Before writing any generator script: call the **create_deliverable** tool with the document content in Markdown. It renders a validated Excel spreadsheets (.xlsx) deterministically (no pip, no script, no shell) and reports structure + content checks in the same call. Repairs are one tool call with corrected content and the same file name.
Use the generator-script workflow below ONLY for highly custom designs the Markdown contract cannot express (precise corporate templates, charts embedded inside the file, custom geometry/styling).

## Core Principle
Write ONE clean, complete generator script, execute it ONCE, verify the file exists on disk, delete the generator script, and finish.

## Setup
- Windows: `py -m pip install openpyxl`
- macOS/Linux: `python3 -m pip install openpyxl`
- Quick verify: `py -c "import openpyxl; print(openpyxl.__version__)"`

## Single-Pass Workflow
1. **Design & Write Generator**:
   Create a generator script (e.g. `generate_sheet.py`) with `write_file`.
   - Freeze header row (`ws.freeze_panes = 'A2'`).
   - Style headers with background fills, bold white font, and borders.
   - Format numbers (currency, percentages, dates) explicitly: `cell.number_format = '$#,##0.00'`.
   - Auto-fit column widths so data is never clipped (`ws.column_dimensions[col_letter].width = max_len + 3`).
2. **Execute**:
   Run: `py generate_sheet.py` (or `python generate_sheet.py`).
3. **Verify & Clean Up**:
   - Check that output exists: `ls`
   - Delete generator script: `rm generate_sheet.py`
   - Complete the task and present the summary to the user.

## STRICT PROHIBITIONS
- **DO NOT write QA/inspection/diagnostic scripts**.
- **DO NOT read binary `.xlsx` files** with `read_file`.
