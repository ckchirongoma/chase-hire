# BA assessment Google Docs (candidate-facing)

Unlike the rest of `assessment-kits/`, these files are **meant for candidates**. They are the
sources of the four Google Docs used by the BA work assessments (docs/06):

| File | Becomes | Shown as |
|---|---|---|
| `BA1-instructions.docx` | BA Part 1 instructions | "open the instructions" link |
| `BA1-answer-template.docx` | BA Part 1 answer template | "Make a copy of the template" button |
| `BA2-instructions.docx` | BA Part 2 instructions | "open the instructions" link |
| `BA2-handoff-template.docx` | BA Part 2 handoff template | "Make a copy of the template" button |

Setup:
1. Upload all four to Google Drive.
2. Open each with Google Docs (Drive converts it), then
   Share → General access → **Anyone with the link** → **Viewer**.
3. Paste the links in the platform at **Admin → Work stages**. A stage can't start until its
   template link is set.

Keep each template's first line (`CHASE-BA1` / `CHASE-BA2`). The platform checks a submitted copy
contains it, which is how it knows the candidate used the template.

To change the wording, edit `scripts/ba-docs/build_docs.py` and run
`python3 scripts/ba-docs/build_docs.py` (needs `python-docx`), then upload again. Changing what a
template asks for is a rubric change: re-run the gold set (docs/09).
