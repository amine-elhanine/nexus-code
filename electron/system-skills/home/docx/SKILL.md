---
name: docx
description: Build formatted Microsoft Word documents (.docx) with python-docx in a single efficient pass. Use when the user asks for a written report, document, proposal, or memo.
---

# docx — Word Document Generation

## Core Principle
Write ONE clean, complete generator script, execute it ONCE, verify the file exists on disk, delete the generator script, and finish.

## Setup
- Windows: `py -m pip install python-docx`
- macOS/Linux: `python3 -m pip install python-docx`
- Quick verify: `py -c "import docx; print(docx.__version__)"`

## Single-Pass Workflow
1. **Design & Write Generator**:
   Create a generator script (e.g. `generate_doc.py`) with `write_file`.
   - Use headings (`doc.add_heading('Title', level=1)`), formatted paragraphs, bullet lists, and tables with headers.
   - Clean professional typography: margins, paragraph spacing, and styled callout boxes.
2. **Execute**:
   Run: `py generate_doc.py` (or `python generate_doc.py`).
3. **Verify & Clean Up**:
   - Check that output exists: `ls`
   - Delete generator script: `rm generate_doc.py`
   - Complete the task and present the summary to the user.

## STRICT PROHIBITIONS
- **DO NOT write QA/inspection/diagnostic scripts**.
- **DO NOT read binary `.docx` files** with `read_file`.
