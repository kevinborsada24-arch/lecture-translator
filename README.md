# Lecture Cleaner

Paste a Panopto (or SRT/WebVTT/plain-text) lecture transcript and get back a
clean, structured Markdown note — ready to drop into Obsidian or hand to
Claude. Everything runs in the browser. No upload, no backend, no AI API.

## Files

- `index.html` — the app
- `styles.css` — permanently-dark UI, no theme toggle
- `app.js` — UI wiring: input, loading state, results, copy/download
- `parser-core.js` — the deterministic parsing engine (see below)
- `parser-tests.js` — the parser's test suite (`node parser-tests.js`)

## Use it

1. Paste a transcript, or add a `.txt` / `.md` / `.srt` / `.vtt` file
   (drag-and-drop onto the input, or the small "Add file" action).
2. Click **Clean Lecture**.
3. Review the result — title, summary stats, and an editable Markdown
   preview appear beneath the input.
4. **Download Cleaned Lecture** or **Copy Markdown**. The title field is
   editable and feeds both the download filename and the `#` heading.
5. For a higher-accuracy final pass, choose **Download Final Review File**
   and upload that single `.txt` file to ChatGPT. It contains the original
   Panopto transcript, the editable cleaned draft, automatic review notes,
   and strict instructions not to invent facts.

## How the parser works, honestly

`parser-core.js` is a rule-based pipeline, not a language model:

1. Normalizes whitespace and line endings.
2. Detects the format (Panopto captions, SRT, WebVTT, or plain text) and
   segments it accordingly.
3. Strips Panopto/player interface chrome, caption metadata, and stray
   timestamps — including ones glued onto a line of real text.
4. Detects speaker labels. A single repeated speaker (the normal
   single-lecturer case) is dropped entirely since it carries no
   information; two or more distinct speakers get normalized `**Name:**`
   markers so a Q&A exchange stays legible.
5. Rejoins caption fragments into real sentences, without merging bullet
   lines or headings into surrounding prose.
6. Conservatively removes filler words, false starts, and exact
   caption-glitch repeats — never touching qualifiers like "not," "may,"
   "increased," or "decreased."
7. Fixes spacing/punctuation and capitalizes sentence starts, without
   ever re-casing a protected abbreviation (pH, PaCO2, COPD, ARDS, V/Q,
   Na+, K+, mg/dL, mEq/L, and others).
8. Groups sentences into topic sections (Definition, Causes & Risk
   Factors, Pathophysiology, Signs & Symptoms, Diagnostics & Lab
   Findings, Treatment & Management, Complications, Nursing
   Considerations) by keyword pattern — only when the transcript actually
   contains that material.
9. Infers a title: an explicit heading, the line Panopto echoes as the
   lecture title, a spoken cue ("today's lecture is about..."), a scored
   recurring phrase, or a plain fallback.
10. A short list of high-confidence corrections for specific,
    previously-seen speech-to-text errors (e.g. "camera dioxide" →
    "carbon dioxide") is applied. Anything numeric that gets corrected is
    flagged in the result so it gets double-checked against the lecture.

It is not perfect. It will occasionally over- or under-split a sentence,
misfile a paragraph under the wrong section, or leave an odd fragment
alone rather than guess. When it isn't confident, it prefers leaving the
original wording over inventing a fix — check the result before relying
on it, especially numeric values and lab ranges.

## Deploy to GitHub Pages

```
git add .
git commit -m "Update Lecture Cleaner"
git push
```

Settings → Pages → Source → Deploy from branch → `main` → `/ (root)`.
Live at `https://kevinborsada24-arch.github.io/lecture-translator/`.

Local assets are versioned with a query string (`styles.css?v=10`, etc.) —
bump the version on any future edit to bust GitHub Pages' cache.
