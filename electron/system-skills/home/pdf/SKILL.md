---
name: pdf
description: Build formatted PDF documents (.pdf) with reportlab or WeasyPrint in a single efficient pass. Use when the user asks for PDF reports, printable brochures, or exports.
---

# pdf — PDF Document Generation

## Core Principle
Write ONE clean, complete generator script, execute it ONCE, verify the file exists on disk, delete the generator script, and finish.

## Setup
- ReportLab: `py -m pip install reportlab`
- Quick verify: `py -c "import reportlab; print(reportlab.__version__)"`

## Single-Pass Workflow
1. **Design & Write Generator**:
   Create a generator script (e.g. `generate_pdf.py`) with `write_file`.
   - Setup page geometry, margins, running headers/footers with page numbers.
   - Use flowables (`Paragraph`, `Spacer`, `Table`, `Image`) with clear styles.
2. **Execute**:
   Run: `py generate_pdf.py` (or `python generate_pdf.py`).
3. **Verify & Clean Up**:
   - Check that output exists: `ls`
   - Delete generator script: `rm generate_pdf.py`
   - Complete the task and present the summary to the user.

## STRICT PROHIBITIONS
- **DO NOT write QA/inspection/diagnostic scripts**.
- **DO NOT read binary `.pdf` files** with `read_file`.
