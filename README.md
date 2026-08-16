# Pathophysio Transcript Cleaner

Paste a Buzz/Whisper or video-player lecture transcript, strip filler words,
fix common speech-to-text errors on medical terms, flag words that look like
mis-transcribed terminology, and export cleaned notes ready for your Obsidian
NCLEX vault. Everything runs in the browser, no upload, no backend.

## Files

- `index.html` — the tool
- `medical-terms.json` — 92k+ term dictionary used for fuzzy-matching (see
  Credits below). Must stay in the same folder as `index.html`.
- `README.md` — this file

## Layout

Two top-level modes: **Single transcript** and **Batch mode**, plus
**Input**/**Output** tabs inside Single mode so you're never scrolling
through both a full paste box and a full output box at once.

## Use it — single transcript

1. Paste your transcript or drop the .md/.txt file (Input tab).
2. Set the lecture title and pick a body system (used for the Obsidian
   export filename/tags — matches how your NCLEX vault is organized).
3. Leave "Strip filler words" and "Flag words that look like mis-transcribed
   medical terms" checked.
4. Hit **Clean transcript** — this switches you to the Output tab automatically.
5. Toggle **Plain output** vs **View diff** to see exactly what changed:
   red strikethrough = removed, green = added/changed. Handy for trusting
   the output instead of taking it on faith.
6. Review "Possible term corrections" — **Add rule** for real catches,
   **Ignore** for false positives.
7. Copy, or download as **.md**, **.txt**, or **Obsidian** (adds YAML
   frontmatter with title/system/date/tags so it drops straight into your
   vault).

## Use it — batch mode

For catching up on several lectures at once: click **Batch mode**, hit
**+ Add transcript** for each lecture, paste each one in with its own title
and body system, then **Clean all**. Each item gets its own "Download for
Obsidian" button, or use **Download all (Obsidian .md)** to grab everything
in one go — your browser will ask to allow multiple downloads the first time.

### How the term-flagging actually works, honestly

This isn't AI and it isn't looking anything up online. It's a local word list
(drug names, anatomy, ICD-9, DSM-IV terms) plus a phonetic-similarity check
(Soundex + edit distance) that runs entirely in your browser. When a
transcribed word isn't in the dictionary and isn't common English, it looks
for the closest real term that *sounds* similar and suggests it.

Tested against two full real lecture transcripts (91 min and 79 min), it
caught genuine errors with zero rules written for them — "nephrpathy,"
"hypertention," "acetominophen," "endonucleosis" — and it also produces some
false positives on ordinary words, roughly 1 in 3-4 flagged words in
testing. That's inherent to phonetic matching on a word list this size.
That's why it's suggest-and-review, not auto-replace — Ignore permanently
dismisses a false positive so it won't nag you again.

## Keeping corrections across the semester

Custom rules save to your browser automatically, but that only covers one
browser on one device. To carry your rules between your laptop and phone,
or back them up:

1. Open "Custom correction rules."
2. Click **Export rules.json** and commit that file to this repo.
3. On another device, click **Import rules.json** and load it.

Re-export and re-commit whenever you add a batch of new fixes so the repo
stays current.

## Deploy to GitHub Pages

```
git init
git add .
git commit -m "Transcript cleaner"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/transcript-cleaner.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Source → Deploy from branch → main
→ / (root)**. Your tool will be live at
`https://YOUR_USERNAME.github.io/transcript-cleaner/`.

`medical-terms.json` is about 1.2MB uncompressed. GitHub Pages serves static
files gzip-compressed automatically, so the real transfer size is smaller,
and your browser caches it after the first load — it's a one-time cost per
device, not per lecture.

## Credits / license note

`medical-terms.json` is derived from
[glutanimate/wordlist-medicalterms-en](https://github.com/glutanimate/wordlist-medicalterms-en),
merged from OpenMedSpel and MTH-Med-Spel-Chek, licensed **GPL-3.0**. That
license applies to that data file. If you ever make this repo public and
someone asks, point them to that source.

## Ideas for later, not built yet

- **UMLS/MeSH-backed lookup** instead of a static word list, so terms newer
  than 2014-2017 (when the current dictionary was last updated) get caught
  too. Needs a free NLM UTS account and considerably more setup — hold off
  unless the static list starts missing a lot of real terms.


