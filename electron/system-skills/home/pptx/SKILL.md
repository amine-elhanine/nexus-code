---
name: pptx
description: Build professional PowerPoint presentations (.pptx) with python-pptx in a single efficient pass. Use when the user asks for slides, a slide deck, or a presentation.
---

# pptx — PowerPoint Deck Generation


## Fast Path First (Default)
Call the **create_deliverable** tool with the deck content in Markdown — it renders a professionally designed, validated .pptx deterministically (designed cover, numbered titles, image embedding, callout cards) with no pip, no script, no shell, and reports structure + content checks in the same call. Repairs are one tool call with corrected content and the same file name. Find 2-4 real image URLs with web_image_search and embed them with "![alt](https://...)" lines per the tool's contract — decks without images look bare.
Only fall back to the generator-script workflow below when the user explicitly supplied a template/brand file to fill or demanded exact custom styling the Markdown contract cannot express.

## Core Principle
Write ONE clean, complete generator script, execute it ONCE, verify the file exists on disk, delete the generator script, and finish. Never write custom QA, contrast, or diagnostic scripts.

## Setup
- Windows: `py -m pip install python-pptx`
- macOS/Linux: `python3 -m pip install python-pptx`
- Quick verify: `py -c "import pptx; print(pptx.__version__)"`

## Single-Pass Workflow
1. **Design & Write Generator**:
   Create a single script (e.g. `generate_deck.py`) using `write_file`.
   - **Widescreen 16:9**:
     ```python
     from pptx import Presentation
     from pptx.util import Inches, Pt
     from pptx.dml.color import RGBColor
     from pptx.enum.text import PP_ALIGN

     prs = Presentation()
     prs.slide_width = Inches(13.33)
     prs.slide_height = Inches(7.5)
     ```
   - **Slide Structure**:
     - **Title Slide**: Clean hero layout with topic, subtitle, date/author, and an executive outline card.
     - **Content Slides**:
       - Kicker / Category tag (small uppercase, e.g. `01 • ARCHITECTURE`)
       - Slide Title (bold Pt(28))
       - Subtitle / context line (Pt(14), muted)
       - Key content cards or 3-5 high-impact bullet takeaways ("Lead bold — explanation")
       - Optional visual card or structured data table
     - **Takeaway / Summary Slide**: Core decisions and next steps.
     - **Footer**: Slide numbering and deck title on every content slide.

2. **Execute**:
   Run the generator: `py generate_deck.py` (or `python generate_deck.py`).

3. **Verify & Clean Up**:
   - Check that the output file exists: `ls`
   - Immediately delete the temporary generator script: `rm generate_deck.py`
   - Stop and present the finished presentation to the user.

## STRICT PROHIBITIONS
- **DO NOT write QA/inspection/contrast/diagnostic scripts** (e.g. `validate_*.py`, `contrast*.py`, `inspect*.py`). The platform automatically validates the presentation structure.
- **DO NOT read binary `.pptx` files** with `read_file`.
- **DO NOT re-generate slides repeatedly** unless an execution error was raised.
