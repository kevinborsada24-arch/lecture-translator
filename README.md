# Pathophysio Transcript Cleaner

Paste a Buzz/Whisper lecture transcript, strip filler words, fix common
speech-to-text errors on medical terms, and flag words that look like
mis-transcribed medical terminology even if they're not in the rule list yet.
Everything runs in the browser, no upload, no backend.

## Files

- `index.html` — the tool
- `medical-terms.json` — 92k+ term dictionary used for fuzzy-matching (see
  Credits below). Must stay in the same folder as `index.html`.
- `README.md` — this file

## Use it

Open `index.html` directly, or once this is on GitHub Pages, just visit the
page URL.

1. Paste your transcript or drop the .md/.txt file.
2. Leave "Strip filler words" checked to drop um/uh/kinda/etc.
3. Leave "Flag words that look like mis-transcribed medical terms" checked.
4. Hit Clean transcript.
5. Below the output, review the "Possible term corrections" panel. For each
   one: **Add rule** if it's a real mis-transcribed term (this fixes it now
   and remembers it for next time), or **Ignore** if it's just an ordinary
   word or a name that happened to look close to something in the dictionary.
6. Copy or download the result.

### How the term-flagging actually works, honestly

This isn't AI and it isn't looking anything up online. It's a local word list
(drug names, anatomy, ICD-9, DSM-IV terms) plus a phonetic-similarity check
(Soundex + edit distance) that runs entirely in your browser. When a
transcribed word isn't in the dictionary and isn't common English, it looks
for the closest real term that *sounds* similar and suggests it.

It catches things you've never manually added a rule for — tested on a
sample transcript, it correctly caught "nephrpathy," "hypertention,"
"tachycardya," and "dysrythmia" without any rule existing for them.

It also produces false positives on ordinary words (in testing, roughly
1 in 2 flagged words was a real word like "afterward" or "discussed" that
just happened to sound close to some obscure dictionary entry). That's why
it's suggest-and-review, not auto-replace — click Ignore on those and they
won't come back.

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

Things that would help more but need more than a weekend to do right:

- **UMLS/MeSH-backed lookup** instead of a static word list, so terms newer
  than 2014-2017 (when the current dictionary was last updated) get caught
  too. Needs a free NLM UTS account and considerably more setup — not worth
  it unless the static list starts missing a lot of real terms.
- **Body-system tagging + Obsidian export** — since your NCLEX vault is
  organized by body system, the cleaner could ask "which system is this
  lecture" and export cleaned transcripts as Obsidian-ready markdown with
  frontmatter, dropped straight into the matching vault folder structure.
- **Diff view** — show the raw and cleaned transcript side by side with
  changes highlighted, so you can eyeball exactly what got changed instead
  of trusting the output blind.
- **Batch mode** — clean multiple lecture transcripts in one sitting instead
  of one paste at a time.

