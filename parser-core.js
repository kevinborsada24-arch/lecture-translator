/*
 * Lecture Cleaner — parsing engine.
 *
 * Turns a raw Panopto / SRT / WebVTT / plain-text transcript into a
 * structured Markdown lecture note. Runs entirely client-side, no network,
 * no AI model — every transform below is a deterministic rule.
 *
 * Pipeline (each stage is a separate function so it stays testable):
 *   1. normalizeInput        - line endings, stray whitespace
 *   2. segmentTranscript     - splits into caption/paragraph units, detects format
 *   3. removeArtifacts       - drops Panopto/player chrome and caption metadata
 *   4. processSpeakers       - detects + strips or normalizes speaker labels
 *   5. reconstructSentences  - joins fragmented captions into real sentences
 *   6. removeFillers         - conservative filler/false-start/stutter removal
 *   7. normalizePunctuation  - spacing, repeated punctuation, capitalization
 *   8. detectSections        - groups sentences into topic sections + lists
 *   9. inferTitle            - explicit title, spoken cue, or scored fallback
 *  10. generateMarkdown      - assembles the final # / ## / ### document
 *  11. generateFilename      - sanitizes the title into a safe .md filename
 *  12. validateResult        - non-blocking sanity checks, surfaced as warnings
 *
 * This is a rule-based parser, not a language model. It is deliberately
 * conservative: when it isn't confident, it leaves the original wording
 * alone rather than guessing. It will miss things and it will occasionally
 * over- or under-split a sentence. It is not perfect.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LectureParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------

  const SINGLE_TIMESTAMP_RE = /^\[?\(?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\)?\]?$/;
  const RANGE_TIMESTAMP_RE = /^(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)(?:\s+.*)?$/;
  // Timestamp tokens embedded inside a line of text, e.g. "so 00:14 the heart..."
  const INLINE_TIMESTAMP_RE = /[\[(]?\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\b[\])]?/g;

  // Lines that are pure Panopto / video-player interface chrome, matched
  // case-insensitively against the whole trimmed line.
  const ARTIFACT_LINE_RES = [
    /^powered by panopto$/i,
    /^search(?: this)? (?:transcript|recording|video)$/i,
    /^search$/i,
    /^auto-?generated captions? may contain errors\.?$/i,
    /^click to seek$/i,
    /^click here to seek$/i,
    /^details?$/i,
    /^contents?$/i,
    /^captions?$/i,
    /^discussion$/i,
    /^notes?$/i,
    /^bookmarks?$/i,
    /^hide$/i,
    /^show more$/i,
    /^show less$/i,
    /^transcript$/i,
    /^\d+ views?$/i,
    /^webvtt$/i,
    /^note\s*$/i,
    /^kind:\s*captions?$/i,
    /^language:\s*[a-z-]+$/i,
    /^align:\S*(?:\s+position:\S*)?(?:\s+line:\S*)?$/i, // VTT cue settings
    /^\d+$/, // bare SRT sequence numbers
    /^\[?(?:music|applause|silence|inaudible|crosstalk)\]?$/i
  ];

  // Filler-only lines that occasionally arrive on their own caption line.
  const FILLER_ONLY_LINE_RE = /^(?:um+|uh+|uhh+|umm+|hmm+|okay|ok|so|yeah|right|alright)[.,!]?$/i;

  // Sentence-final abbreviations whose period must not be treated as a
  // sentence boundary. Kept short and medically relevant on purpose.
  const NO_SPLIT_ABBR = ["dr", "mr", "mrs", "ms", "prof", "vs", "etc", "e.g", "i.e", "fig", "approx", "no", "vol", "cf", "st", "jr", "sr"];

  // A speaker label at the start of a line: "Professor:", "Instructor Smith:",
  // "Speaker 1:", "Dr. Alassal:". Deliberately requires a trailing colon so
  // it only fires on real labels, not on sentences that happen to start
  // with a capitalized word.
  const SPEAKER_LABEL_RE = /^\s*(?:>>\s*)?((?:Professor|Instructor|Speaker|Dr\.?|Prof\.?)(?:\s+[A-Z][A-Za-z.'-]*){0,2}\s*\d*|[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s*(?:[\[(]?\d{1,2}:\d{2}(?::\d{2})?[\])]?)?\s*:\s*/;

  // Medical/technical abbreviations that must never be re-cased. This list
  // exists so normalizePunctuation can promise it never touches them.
  const PROTECTED_TERMS = [
    "pH", "PaCO2", "PaO2", "HCO3-", "HCO3−", "COPD", "ARDS", "V/Q", "Na+", "K+",
    "Ca2+", "Mg2+", "mg/dL", "mEq/L", "mmHg", "IV", "IM", "PO", "NPO", "PRN",
    "BID", "TID", "QID", "STAT", "ABG", "CBC", "BUN", "GFR", "ICU", "ER", "ED",
    "DKA", "HHS", "SIADH", "GERD", "UTI", "DVT", "PE", "MI", "CHF", "CAD",
    "COPD", "TIA", "CVA", "NCLEX", "RN", "BSN", "WBC", "RBC", "Hgb", "Hct",
    "INR", "PT", "PTT", "aPTT", "BP", "HR", "RR", "SpO2", "O2", "CO2"
  ];

  // Enumeration/list-lead phrases used to detect "include: a, b, and c".
  const ENUMERATION_LEAD_RE = /^(.*?\b(?:includes|including|include|such as))\b:?\s*(.+)$/i;

  // Deliberately excludes "Then" and "Next" — in spoken lecture style those
  // are just narrative connectors ("Then we have...", "Then you have it
  // again...") almost never an actual enumerated sequence, and including
  // them turned ordinary run-on speech into a scatter of bogus one-item
  // numbered lists.
  const ORDINAL_RE = /^(First|Second|Third|Fourth|Fifth|Sixth|Finally|Lastly|Last)\b[,:]?\s+/i;

  // Panopto repeats the lecture's title on every screen, right after the
  // player chrome and before the caption notice/timestamps start. When
  // present this is a much more reliable title than anything inferred from
  // word frequency, so it's detected and pulled out before segmentation.
  const PANOPTO_HEADER_RE = /^powered by panopto$/i;
  const PANOPTO_NOTICE_RE = /^auto-?generated captions? may contain errors\.?$/i;

  // If a transcript has already been through an export/cleanup pass before
  // (this tool's own old output, or a similar one) it carries its own
  // "# Title" + "## Cleaned Lecture Transcript" + disclaimer blockquote at
  // the top. Left alone, that wrapper gets parsed as if it were lecture
  // content and turns into a giant bogus heading. It's stripped before
  // anything else runs.
  const OLD_WRAPPER_SUBHEADING_RE = /^#{1,2}\s*cleaned lecture transcript\s*$/i;
  const OLD_WRAPPER_QUOTE_RE = /^>\s*cleaned from a .*transcript.*$/i;

  function stripOldExportWrapper(lines) {
    const output = [...lines];
    const removed = [];
    // A leading "# <title>" line from a previous export.
    if (output[0] && /^#\s+\S/.test(output[0].trim()) && !PANOPTO_HEADER_RE.test(output[0].trim())) {
      removed.push(output.shift());
    }
    while (output.length) {
      const trimmed = output[0].trim();
      if (!trimmed || OLD_WRAPPER_SUBHEADING_RE.test(trimmed) || OLD_WRAPPER_QUOTE_RE.test(trimmed)) {
        removed.push(output.shift());
      } else {
        break;
      }
    }
    return { lines: output, removed };
  }

  // Panopto's own page chrome (Search / Details / Contents / Chapters /
  // Bookmarks / etc.) sits as a block between the "Powered by Panopto"
  // header and where the actual caption stream starts. Rather than trying
  // to name every possible chrome line (a chapter list has arbitrary title
  // text, for instance, so no fixed pattern catches it), the whole block is
  // cut by position: everything from the header up to the caption notice,
  // or up to the first real timestamp if there's no notice, is chrome.
  function stripPanoptoChromeBlock(lines) {
    const headerIndex = lines.findIndex(line => PANOPTO_HEADER_RE.test(line.trim()));
    if (headerIndex === -1) return { lines, removed: [] };
    const noticeIndex = lines.findIndex((line, i) => i > headerIndex && PANOPTO_NOTICE_RE.test(line.trim()));
    let bodyStart;
    if (noticeIndex !== -1) {
      bodyStart = noticeIndex + 1;
    } else {
      const firstTimestamp = lines.findIndex((line, i) => i > headerIndex && (SINGLE_TIMESTAMP_RE.test(line.trim()) || RANGE_TIMESTAMP_RE.test(line.trim())));
      bodyStart = firstTimestamp !== -1 ? firstTimestamp : headerIndex + 1;
    }
    return {
      lines: [...lines.slice(0, headerIndex), ...lines.slice(bodyStart)],
      removed: lines.slice(headerIndex, bodyStart)
    };
  }

  // Corrections carried over from real transcripts run through the
  // previous version of this tool (PATH 370 lectures). These are
  // deliberately narrow, high-confidence fixes for known speech-to-text
  // errors on specific medical terms — not general rewriting. `when`
  // scopes a rule to transcripts that are actually on-topic for it, so
  // "Laura" only becomes "pleura" in a respiratory lecture, for example.
  // Only strong, repeatable corrections belong here; anything uncertain
  // goes through REVIEW_PATTERNS instead, as a flag rather than a rewrite.
  const MEDICAL_RULES = [
    { id: "carbon-dioxide", find: /\bcamera dioxide\b/gi, replace: "carbon dioxide", confidence: 0.99 },
    { id: "ph-range", find: /\b7\.35\s+(?:to|through|and)\s+2745\b/gi, replace: "7.35 to 7.45", confidence: 0.99, numeric: true },
    { id: "parathyroid", find: /\bparent thyroid(?: gland)?\b/gi, replace: "parathyroid gland", confidence: 0.98 },
    { id: "osteoclast", find: /\b(?:osteo|I still) class(?:es)?\b/gi, replace: "osteoclasts", when: /calcium|bone|parathyroid|osteoblast/i, confidence: 0.96 },
    { id: "hypocalcemia", find: /\bhypo calcium\b/gi, replace: "hypocalcemia", confidence: 0.98 },
    { id: "pneumothorax", find: /\bno more thorax\b/gi, replace: "pneumothorax", confidence: 0.99 },
    { id: "pleural-effusion", find: /\bplural effusion\b/gi, replace: "pleural effusion", confidence: 0.99 },
    { id: "pleural-cavity", find: /\b(?:plural|oral) cavity\b/gi, replace: "pleural cavity", when: /pleur|lung|thorax/i, confidence: 0.95 },
    { id: "parietal-pleura", find: /\b(?:pride on|parietal) pleura\b/gi, replace: "parietal pleura", when: /pleur|lung|thorax/i, confidence: 0.96 },
    { id: "pleura-laura", find: /\bLaura\b/g, replace: "pleura", when: /pleur|lung|thorax|pneumothorax/i, confidence: 0.93 },
    { id: "blue-bloater", find: /\bblue below their\b/gi, replace: "blue bloater", when: /copd|bronchitis|emphysema/i, confidence: 0.98 },
    { id: "pulmonary-trunk", find: /\bfront primary trunk\b/gi, replace: "pulmonary trunk", when: /heart|lung|ventricle/i, confidence: 0.96 },
    { id: "atrial-natriuretic", find: /\batrial naturally urinating peptide\b/gi, replace: "atrial natriuretic peptide", confidence: 0.99 },
    { id: "hormones", find: /\bor moons\b/gi, replace: "hormones", when: /nutrient|oxygen|transport|fluid/i, confidence: 0.94 },
    { id: "transudate-transfer", find: /\btransfer\b/gi, replace: "transudate", when: /pleural effusion|exudate/i, confidence: 0.91 },
    { id: "transudate-transgene", find: /\btransgene\b/gi, replace: "transudate", when: /pleural effusion|exudate/i, confidence: 0.91 },
    { id: "vitamin-d-mindy", find: /\bMindy(?:'s)?\b/g, replace: "vitamin D", when: /calcium|parathyroid|absorb/i, confidence: 0.9 },
    { id: "ph-pitch", find: /\bpitch\b/gi, replace: "pH", when: /acid|base|enzyme|7\.3/i, confidence: 0.92 },
    { id: "ards-art", find: /\barts?\b/gi, replace: "ARDS", when: /acute respiratory distress|refractory hypoxemia|respiratory distress syndrome/i, confidence: 0.95 },
    { id: "fev1", find: /\bEV1\b/g, replace: "FEV₁", when: /pulmonary function|spirometry|FVC|obstructive|restrictive|forced expiratory/i, confidence: 0.9 },
    { id: "fvc", find: /\bFCC\b/g, replace: "FVC", when: /pulmonary function|spirometry|FEV|forced vital capacity|obstructive|restrictive/i, confidence: 0.88 },
    { id: "pft", find: /\bPFC\b/g, replace: "PFT", when: /pulmonary function test|spirometry|FEV|FVC/i, confidence: 0.85 },
    { id: "ph-spaced", find: /\bp\s+h\b/gi, replace: "pH", when: /acid-?base|7\.3|7\.4/i, confidence: 0.99 },
    { id: "weak-acid", find: /\bweak asset\b/gi, replace: "weak acid", when: /carbon dioxide|acid-?base/i, confidence: 0.99 },
    { id: "mucociliary", find: /\bmiracle ciliary escalator\b/gi, replace: "mucociliary escalator", when: /cilia|mucus|bronch/i, confidence: 0.99 },
    { id: "barrel-chest", find: /\bbarren chance\b/gi, replace: "barrel chest", when: /obstructive|COPD|hyperinflation/i, confidence: 0.99 },
    { id: "hypercapnia-pair", find: /\bhypocalcemia\b/gi, replace: "hypercapnia", when: /hypocalcemia[\s\S]{0,120}Cadmium means carbon dioxide/i, confidence: 0.99 },
    { id: "capnia-pair", find: /\bCadmium\b/gi, replace: "Capnia", when: /hypocalcemia[\s\S]{0,120}Cadmium means carbon dioxide/i, confidence: 0.99 },
    { id: "acidosis-garbled", find: /\bacetone sits\b/gi, replace: "acidosis", when: /acid-?base|pH|alkalosis|bicarbonate/i, confidence: 0.99 },
    { id: "alkalosis-garbled", find: /\bit'?s a cannot take\b/gi, replace: "we call it alkalosis", when: /acid-?base|pH|acidosis|bicarbonate/i, confidence: 0.98 },
    { id: "hypoventilation-retains", find: /\bhyperventilation keeps the carbon dioxide\b/gi, replace: "hypoventilation retains carbon dioxide", when: /acid-?base|respiratory|compens/i, confidence: 0.99 },
    { id: "pneumothorax-tags", find: /\bno more (?:tags?|tracks?)\b/gi, replace: "pneumothorax", when: /pneumothorax|pleural cavity|collapsed lung/i, confidence: 0.99 },
    { id: "bradykinin", find: /\bBrando priming\b/gi, replace: "bradykinin", when: /ARDS|histamine|cytokine/i, confidence: 0.99 },
    { id: "hyaline-membrane", find: /\bhigher name memory\b/gi, replace: "hyaline membrane", when: /ARDS|alveol|protein/i, confidence: 0.99 },
    { id: "peep-expansion", find: /\bpositive in explanatory pressure\b/gi, replace: "positive end-expiratory pressure", when: /PEEP|ventilator|ARDS/i, confidence: 0.99 },
    { id: "bowmans-capsule", find: /\b(?:Balmain|involvement|blue minus|vomit) capsule\b/gi, replace: "Bowman's capsule", when: /kidney|renal|nephron|glomerul|urine/i, confidence: 0.99 },
    { id: "bowmans-blue-minus", find: /\binside the blue minus\b/gi, replace: "inside Bowman's capsule", when: /kidney|renal|nephron|glomerul|urine/i, confidence: 0.98 },
    { id: "proximal-tubule", find: /\bproximal (?:to balance|oculus|in turbulence)\b/gi, replace: "proximal tubule", when: /kidney|renal|nephron|glomerul|urine/i, confidence: 0.98 },
    { id: "loop-of-henle", find: /\bloop of (?:Henry|enemy|only)\b/gi, replace: "loop of Henle", when: /kidney|renal|nephron|glomerul|urine/i, confidence: 0.99 },
    { id: "distal-tubule", find: /\b(?:restart to release|distant two minutes|distal two minutes|less than two bullets)\b/gi, replace: "distal tubules", when: /kidney|renal|nephron|glomerul|urine/i, confidence: 0.97 },
    { id: "glomerulus-garbled", find: /\b(?:gloominess|glomus)\b/gi, replace: "glomerulus", when: /kidney|renal|nephron|capillary|urine/i, confidence: 0.98 },
    { id: "afferent-intro", find: /\bthis so called a friend(?: are telling a friend)?\b/gi, replace: "the afferent arteriole", when: /kidney|renal|nephron|glomerul/i, confidence: 0.98 },
    { id: "afferent-through", find: /\bthrough the a friend\b/gi, replace: "through the afferent arteriole", when: /kidney|renal|nephron|glomerul/i, confidence: 0.99 },
    { id: "afferent-have", find: /\bYou have a friend\b/gi, replace: "You have the afferent arteriole", when: /kidney|renal|nephron|glomerul/i, confidence: 0.97 },
    { id: "detrusor-muscle", find: /\bWeakening the troops in muscle\b/gi, replace: "The detrusor muscle", when: /bladder|urethra|urine/i, confidence: 0.98 },
    { id: "nitrogenous-waste", find: /\bnitrogen based methods\b/gi, replace: "nitrogenous waste products", when: /kidney|renal|urea|uric acid/i, confidence: 0.98 },
    { id: "reabsorbing-vessels", find: /\bobserving into the blood vessels\b/gi, replace: "reabsorbing into the blood vessels", when: /kidney|renal|filtration|tubular/i, confidence: 0.98 },
    { id: "filtration-issue", find: /\brefraction issue\b/gi, replace: "filtration issue", when: /kidney|renal|filtration|reabsorption/i, confidence: 0.99 },
    { id: "holy-grail", find: /\bholy green on Hatha physiology\b/gi, replace: "holy grail of pathophysiology", when: /kidney|renal|urine|filtration/i, confidence: 0.97 },
    { id: "low-urine-output", find: /\blow during output\b/gi, replace: "low urine output", when: /kidney|renal|urine|filtration/i, confidence: 0.99 },
    { id: "urine-production", find: /\b(?:no unit production|too much during production)\b/gi, replace: match => /no unit/i.test(match) ? "no urine production" : "too much urine production", when: /kidney|renal|urine|filtration/i, confidence: 0.98 },
    { id: "blood-volume", find: /\bhigh blood loss\b/gi, replace: "high blood volume", when: /no urine|low urine|preload|kidney/i, confidence: 0.99 },
    { id: "cardiac-output", find: /\bProject output\b/gi, replace: "cardiac output", when: /stroke volume|blood pressure|preload/i, confidence: 0.99 },
    { id: "urine-liters", find: /\b1 to 2 million\b/gi, replace: "1 to 2 liters", when: /urinate|urine output|800ml|2000/i, confidence: 0.99 },
    { id: "urine-milliliters", find: /\b800ml to 2000mg\b/gi, replace: "800 mL to 2000 mL", when: /urinate|urine output|kidney/i, confidence: 0.99 },
    { id: "hematuria", find: /\bUTM\b/g, replace: "hematuria", when: /red blood cells in (?:the )?urine/i, confidence: 0.97 },
    { id: "leukopenia", find: /\bcall pinyon\b/gi, replace: "leukopenia", when: /low white blood cells|white blood cells in the blood/i, confidence: 0.97 },
    { id: "hypoalbuminemia", find: /\bhypo and B anemia\b/gi, replace: "hypoalbuminemia", when: /low protein|proteinuria|blood/i, confidence: 0.98 },
    { id: "uremic-syndrome", find: /\bremix syndrome\b/gi, replace: "uremic syndrome", when: /kidney|renal|urea|BUN/i, confidence: 0.99 },
    { id: "chronic-pruritus", find: /\bchronic back items\b/gi, replace: "chronic pruritus", when: /urea|sweat glands|skin/i, confidence: 0.97 },
    { id: "serum-creatinine", find: /\bserum platinum\b/gi, replace: "serum creatinine", when: /GFR|kidney|renal|filtration/i, confidence: 0.99 },
    { id: "bun", find: /\bserum un\b/gi, replace: "BUN", when: /GFR|kidney|renal|filtration/i, confidence: 0.99 },
    { id: "gfr-unit", find: /\b(?:120 milligram|120,000,000l) per minute\b/gi, replace: "120 mL/min", when: /GFR|glomerular filtration|kidney/i, confidence: 0.99 },
    { id: "oliguria-unit", find: /\bless than 400 milligram\b/gi, replace: "less than 400 mL per day", when: /urine output|kidney|renal/i, confidence: 0.99 },
    { id: "three-hour-urine", find: /\b(?:six minutes|16 millimeter)\b/gi, replace: "60 mL", when: /three hours|24 hours|urine output/i, confidence: 0.98 },
    { id: "aki-output-rate", find: /\b0\.5 meaning that a kilogram in six hours\b/gi, replace: "0.5 mL/kg/hr for six hours", when: /urine output|kidney injury|kidney failure/i, confidence: 0.99 },
    { id: "aki-math", find: /\b650 times six\b/gi, replace: "50 times six", when: /100 times 0\.5|300 in 6 hours/i, confidence: 0.99 },
    { id: "rule-of-thumb", find: /\bright thumb metal\b/gi, replace: "rule-of-thumb method", when: /kidney|urine output|diagnostic/i, confidence: 0.98 }
  ];

  // Terms found to be common speech-to-text confusions in real nursing
  // lectures, but too risky to auto-replace: each one is also a real,
  // independent medical term, so a blind find-and-replace could silently
  // turn a correct statement into a wrong one. These are surfaced as
  // review flags instead — "double-check this" rather than "fixed this" —
  // which is the safer failure mode for anything touching patient care
  // content. `when` still scopes the flag to transcripts where the mix-up
  // is actually plausible, so an ordinary calcium lecture saying
  // "hypocalcemia" doesn't get flagged just because the word exists.
  const REVIEW_PATTERNS = [
    {
      find: /\bhypocalcemia\b/i,
      when: /carbon dioxide|hypercapnia|hypoventilation|respiratory failure|PaCO2/i,
      unless: /parathyroid|vitamin d|chvostek|trousseau|calcium (?:level|deficiency)/i,
      message: "“Hypocalcemia” appears near CO2/respiratory-failure language — this is a known speech-to-text mix-up with “hypercapnia.” Verify against the lecture."
    },
    {
      find: /\bcadmium\b/i,
      when: /respirat|lung|ventilat|gas exchange|hypoxia|hypercapnia/i,
      message: "“Cadmium” in a respiratory context is a known mis-transcription of “carbon dioxide.” Verify against the lecture."
    },
    {
      find: /\bacetone\b/i,
      when: /acid-?base|pH|alkalosis|bicarbonate|respiratory failure/i,
      unless: /diabetic ketoacidosis|DKA|ketone|breath odor/i,
      message: "“Acetone” appears in an acid-base discussion — this can be a mis-transcription of “acidosis.” Verify against the lecture."
    },
    {
      find: /\bcannot take\b/i,
      when: /acid-?base|pH|acidosis|bicarbonate/i,
      message: "“Cannot take” near acid-base language may be a mis-transcription of “alkalosis.” Verify against the lecture."
    },
    {
      find: /\b(?:incoming postural|postural lateral|quantity of the wound|big money|Lupron urea|basement and toxin|GFR or 20|Funny Men)\b/i,
      when: /kidney|renal|nephron|glomerul|urine/i,
      message: "One or more kidney anatomy/laboratory phrases remain ambiguous after cleanup. Compare the cleaned lecture content with the slide before studying it."
    },
    {
      find: /\b(?:200|70%|30%|0\.5|400|2000|GFR)\b/i,
      when: /kidney|renal|nephron|glomerul|urine output/i,
      message: "This kidney lecture contains filtration, urine-output, or AKI numbers. Verify every value and unit against the lecture slide."
    },
    {
      find: /\bARDS\b/,
      when: /\bPEEP\b|surfactant|hyaline/i,
      message: "This section covers ARDS with PEEP/surfactant/hyaline membrane terminology — a frequent trouble spot for speech-to-text. Read this section closely against your notes."
    }
  ];

  // Phrases that signal the professor is flagging something as testable.
  // These get promoted to a blockquote so they stand out without inventing
  // any new content.
  const EMPHASIS_RE = /\b(?:this (?:will|could|might|is going to) be (?:on|tested on) (?:the |your )?(?:test|exam|quiz|nclex)|make sure you (?:know|understand|remember|can identify)|know this for (?:the )?(?:test|exam|nclex)|(?:this|that) is (?:definitely |absolutely )?(?:a |an )?(?:key|high-?yield|classic|favorite) (?:nclex )?(?:question|point|topic)|(?:i|we)'?ll ask (?:you |this )?(?:on|about) (?:the )?(?:test|exam))\b/i;

  // Section categories, in the order they should appear when several are
  // detected with equal first-appearance order preserved otherwise.
  // Tightened after real-transcript testing showed generic connectors
  // ("leads to," "results in," "due to," "can lead to") firing on almost
  // any clinical sentence and scattering wrong headings throughout the
  // note. Every trigger left here is a phrase that's specific to its
  // category, not just common in clinical speech generally — precision
  // over recall, since a wrong heading is worse than no heading.
  const SECTION_RULES = [
    { id: "definition", heading: "Definition", test: /\bis defined as\b|\bby definition\b/i },
    { id: "causes", heading: "Causes & Risk Factors", test: /\bcause[sd]? by\b|\brisk factors?\b|\betiology\b|\bpredispos(?:e|ing|ition)\b/i },
    { id: "pathophysiology", heading: "Pathophysiology", test: /\bpathophysiology\b|\bunderlying mechanism\b|\boccurs when\b|\bvicious cycle\b|\bcompensat(?:e|ory|ion)\b/i },
    { id: "signs_symptoms", heading: "Signs & Symptoms", test: /\bsigns? and symptoms?\b|\bpresents? with\b|\bclinical (?:manifestations?|presentation)\b|\b(?:patients?|they)\s+(?:will |may |often |typically )?(?:present|exhibit|show|report|complain)/i },
    { id: "diagnostics", heading: "Diagnostics & Lab Findings", test: /\bdiagnos(?:is|ed|tic)\b|\blab(?:oratory)? (?:values?|findings?|results?|work-?up)\b|\bx-?ray\b|\bimaging\b|\bABG\b|\bwill (?:show|reveal)\b.{0,30}\b(?:elevated|decreased|low|high)\b/i },
    { id: "treatment", heading: "Treatment & Management", test: /\btreatment\b|\bmanagement\b|\bmedications?\b|\badminister\b|\btherapy\b|\bfirst-?line\b|\bintervention\b/i },
    { id: "complications", heading: "Complications", test: /\bcomplications?\b|\bif (?:left )?untreated\b/i },
    { id: "nursing", heading: "Nursing Considerations", test: /\bnursing (?:consideration|intervention|priorit(?:y|ies)|assessment)s?\b|\bnurse'?s? role\b|\bmonitor (?:for|the)\b|\bassess (?:for|the)\b|\bpriority (?:action|intervention)\b/i }
  ];

  // ---------------------------------------------------------------------
  // Stage 1 — input normalization
  // ---------------------------------------------------------------------

  function normalizeInput(raw) {
    return String(raw || "")
      .replace(/\r\n?/g, "\n")
      .replace(/ /g, " ")
      .replace(/​/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();
  }

  // ---------------------------------------------------------------------
  // Stage 2 — segmentation (detect format, split into caption/paragraph units)
  // ---------------------------------------------------------------------

  function detectFormat(lines) {
    if (lines.some(line => RANGE_TIMESTAMP_RE.test(line.trim()))) {
      return lines.some(line => /^WEBVTT\b/i.test(line.trim())) ? "vtt" : "srt";
    }
    if (lines.some(line => SINGLE_TIMESTAMP_RE.test(line.trim()))) return "panopto";
    return "text";
  }

  function segmentTimedCaptions(lines) {
    const units = [];
    let i = 0;
    while (i < lines.length) {
      const range = lines[i].trim().match(RANGE_TIMESTAMP_RE);
      if (!range) { i++; continue; }
      const start = range[1].replace(",", ".");
      i++;
      const caption = [];
      while (i < lines.length && lines[i].trim() && !RANGE_TIMESTAMP_RE.test(lines[i].trim())) {
        if (!/^\d+$/.test(lines[i].trim())) caption.push(lines[i].replace(/<[^>]+>/g, "").trim());
        i++;
      }
      const text = caption.join(" ").replace(/\s+/g, " ").trim();
      if (text) units.push({ timestamp: start, text, kind: "caption" });
    }
    return units;
  }

  function segmentPanoptoCaptions(lines) {
    const units = [];
    let pending = [];
    let pendingTimestamp = "";
    for (const originalLine of lines) {
      const line = originalLine.trim();
      if (!line) continue;
      const match = line.match(SINGLE_TIMESTAMP_RE);
      if (match) {
        const text = pending.join(" ").replace(/\s+/g, " ").trim();
        if (text) units.push({ timestamp: pendingTimestamp, text, kind: "caption" });
        pendingTimestamp = match[1].replace(",", ".");
        pending = [];
      } else {
        pending.push(line);
      }
    }
    if (pending.length) {
      const text = pending.join(" ").replace(/\s+/g, " ").trim();
      if (text) units.push({ timestamp: pendingTimestamp, text, kind: "caption" });
    }
    return units;
  }

  function segmentPlainText(lines) {
    const chunks = lines.join("\n").split(/\n\s*\n+/).map(v => v.trim()).filter(Boolean);
    const units = [];
    for (const chunk of chunks) {
      const chunkLines = chunk.split("\n").map(l => l.trim()).filter(Boolean);
      // A chunk that mixes several speaker turns or list items into one
      // blank-line-delimited block (common when a transcript has no blank
      // lines between speaker labels) needs to stay split by physical line
      // so speaker/bullet detection downstream can see each one. A normal
      // prose paragraph gets its line breaks collapsed into flowing text.
      const needsLineSplit = chunkLines.length > 1 && chunkLines.some(l => SPEAKER_LABEL_RE.test(l) || isBulletLine(l) || isHeadingLine(l));
      if (needsLineSplit) {
        for (const line of chunkLines) units.push({ timestamp: "", text: line, kind: "block" });
      } else {
        units.push({ timestamp: "", text: chunkLines.join(" ").replace(/\s+/g, " ").trim(), kind: "block" });
      }
    }
    return units;
  }

  function segmentTranscript(lines, format) {
    if (format === "srt" || format === "vtt") return segmentTimedCaptions(lines);
    if (format === "panopto") return segmentPanoptoCaptions(lines);
    return segmentPlainText(lines);
  }

  // Finds the line Panopto echoes as the lecture title, and reports which
  // line index it lives at so the caller can drop it from the body too.
  function detectPanoptoTitle(lines) {
    const headerIndex = lines.findIndex(line => PANOPTO_HEADER_RE.test(line.trim()));
    if (headerIndex === -1) return { title: "", index: -1 };
    for (let i = headerIndex + 1; i < Math.min(lines.length, headerIndex + 8); i++) {
      const candidate = lines[i].trim();
      if (!candidate) continue;
      if (PANOPTO_NOTICE_RE.test(candidate) || ARTIFACT_LINE_RES.some(re => re.test(candidate))) continue;
      if (SINGLE_TIMESTAMP_RE.test(candidate) || RANGE_TIMESTAMP_RE.test(candidate)) break;
      return { title: cleanTitleText(candidate), index: i };
    }
    return { title: "", index: -1 };
  }

  // ---------------------------------------------------------------------
  // Stage 3 — artifact removal
  // ---------------------------------------------------------------------

  // Strips interface chrome lines before segmentation, and also strips any
  // timestamp tokens left sitting inside a line of text (a caption line that
  // has a stray in-line timestamp glued to it).
  function removeArtifacts(lines) {
    const removed = [];
    const kept = [];
    // Repeated standalone lines (the lecture title echoed by the Panopto
    // player on every screen, a recurring section header, etc.) are chrome,
    // not content — but only when the line is short and appears 3+ times.
    const counts = new Map();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length > 70) continue;
      counts.set(trimmed.toLowerCase(), (counts.get(trimmed.toLowerCase()) || 0) + 1);
    }
    const repeatedChrome = new Set([...counts.entries()].filter(([, n]) => n >= 3).map(([text]) => text));

    for (const originalLine of lines) {
      const trimmed = originalLine.trim();
      if (!trimmed) { kept.push(originalLine); continue; }
      const isArtifact = ARTIFACT_LINE_RES.some(re => re.test(trimmed)) ||
        FILLER_ONLY_LINE_RE.test(trimmed) ||
        repeatedChrome.has(trimmed.toLowerCase());
      if (isArtifact) { removed.push(originalLine); continue; }
      // A line that IS a timestamp (single cue or an SRT/VTT range) is left
      // completely alone here — segmentTranscript is what consumes it. Only
      // a timestamp glued onto real prose gets stripped below.
      const isPureTimestampLine = SINGLE_TIMESTAMP_RE.test(trimmed) || RANGE_TIMESTAMP_RE.test(trimmed) || /^\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\s+align:/i.test(trimmed);
      if (isPureTimestampLine) { kept.push(originalLine); continue; }
      kept.push(stripInlineTimestampNoise(originalLine, removed));
    }
    return { lines: kept.filter(l => l !== undefined), removed };
  }

  // Removes a timestamp token that is glued onto an otherwise-normal line
  // of prose (e.g. "...and the heart 00:14 continues to..."). A line that
  // is *only* a timestamp is handled separately during segmentation, so
  // this only fires mid-sentence.
  function stripInlineTimestampNoise(line, removedLog) {
    if (!INLINE_TIMESTAMP_RE.test(line)) return line;
    const cleaned = line.replace(INLINE_TIMESTAMP_RE, (match) => {
      removedLog.push(match);
      return "";
    }).replace(/\s{2,}/g, " ").trim();
    // Deliberately NOT falling back to the original line when cleaned is
    // empty: an empty result means the whole line was timestamps (e.g. a
    // Panopto bookmark row: "0:09 1:57 12:18 13:12") with nothing else on
    // it, which is chrome, not content — dropping it is correct.
    return cleaned;
  }

  // ---------------------------------------------------------------------
  // Stage 4 — speaker processing
  // ---------------------------------------------------------------------

  // Detects speaker labels across all units first. If only one distinct
  // speaker is ever labeled (the common single-lecturer Panopto case), the
  // labels carry no information and are stripped entirely. If two or more
  // distinct speakers appear (Q&A, guest lecturer), labels are normalized
  // to a bold "**Name:**" marker so the switch stays visible in the note.
  function processSpeakers(units) {
    const speakers = new Set();
    const withLabels = units.map(unit => {
      const match = unit.text.match(SPEAKER_LABEL_RE);
      if (!match) return { ...unit, speaker: null };
      const speaker = normalizeSpeakerName(match[1].trim());
      speakers.add(speaker);
      return { ...unit, speaker, text: unit.text.slice(match[0].length).trim() };
    });

    if (speakers.size <= 1) {
      // Single speaker (or none labeled) — the label added no information.
      return withLabels.map(unit => ({ timestamp: unit.timestamp, text: unit.text, kind: unit.kind }));
    }

    // Multiple speakers — collapse consecutive units from the same speaker
    // and prefix the run with a normalized marker.
    const merged = [];
    let lastSpeaker = null;
    for (const unit of withLabels) {
      const speaker = unit.speaker || lastSpeaker;
      if (speaker && speaker !== lastSpeaker) {
        merged.push({ timestamp: unit.timestamp, text: `**${speaker}:** ${unit.text}`, kind: unit.kind });
      } else {
        merged.push({ timestamp: unit.timestamp, text: unit.text, kind: unit.kind });
      }
      lastSpeaker = speaker;
    }
    return merged;
  }

  function normalizeSpeakerName(name) {
    const trimmed = name.replace(/\.$/, "").trim();
    if (/^speaker\b/i.test(trimmed)) return trimmed.replace(/^speaker/i, "Speaker");
    if (/^prof\.?$/i.test(trimmed)) return "Professor";
    return trimmed.replace(/\b\w/g, c => c.toUpperCase());
  }

  // ---------------------------------------------------------------------
  // Stage 5 — sentence reconstruction
  // ---------------------------------------------------------------------

  function protectAbbreviationPeriods(text) {
    let protected_ = text;
    for (const abbr of NO_SPLIT_ABBR) {
      protected_ = protected_.replace(new RegExp(`\\b${abbr.replace(".", "\\.")}\\.(?=\\s)`, "gi"), m => m.slice(0, -1) + "\u0001");
    }
    // Decimal numbers and lab-value ranges: 7.35, PaCO2 45.5, etc.
    protected_ = protected_.replace(/(\d)\.(\d)/g, "$1\u0001$2");
    return protected_;
  }

  function restoreProtectedPeriods(text) {
    return text.replace(/\u0001/g, ".");
  }

  function splitIntoSentences(text) {
    const protected_ = protectAbbreviationPeriods(text);
    // Split on sentence-ending punctuation followed by whitespace. Deliberately
    // not requiring the next character to be uppercase — real transcripts
    // (and this test suite) include sentences with sloppy capitalization,
    // and abbreviation/decimal periods are already protected above.
    const parts = protected_.split(/(?<=[.!?])\s+/);
    return parts.map(part => restoreProtectedPeriods(part).trim()).filter(Boolean);
  }

  function isBulletLine(text) {
    return /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(text);
  }

  // Deliberately strict: a caption fragment with no terminal punctuation
  // ("The liver metabolizes most drugs") looks a lot like a short heading
  // if the bar is just "short and capitalized." Requiring an explicit
  // markdown "#" or a trailing colon avoids misreading ordinary fragments
  // as section headings.
  function isHeadingLine(text) {
    return /^#{1,3}\s+\S/.test(text) ||
      (/^[A-Z][A-Za-z0-9 &/-]{2,50}:$/.test(text) && text.split(" ").length <= 7);
  }

  // Joins fragmented caption units into whole sentences, while leaving
  // bullet lines, heading-like lines and already-blank-line-delimited
  // paragraphs (plain-text format) alone so real structure isn't flattened.
  function reconstructSentences(units, format) {
    if (format === "text") {
      // Plain text already carries real paragraph breaks — trust them and
      // just re-split each paragraph into sentences for downstream staging.
      const sentences = [];
      for (const unit of units) {
        if (isBulletLine(unit.text) || isHeadingLine(unit.text)) {
          sentences.push({ text: unit.text.trim(), timestamp: unit.timestamp, structural: true });
          continue;
        }
        for (const sentence of splitIntoSentences(unit.text)) {
          sentences.push({ text: sentence, timestamp: unit.timestamp, structural: false });
        }
      }
      return sentences;
    }

    // Caption formats: fragments have no paragraph structure at all, just
    // short bursts. Buffer text until we hit a sentence boundary, a bullet
    // line, or a heading-like line, and flush there.
    const sentences = [];
    let buffer = "";
    let bufferTimestamp = "";
    const flush = () => {
      const text = buffer.trim();
      if (text) {
        for (const sentence of splitIntoSentences(text)) {
          sentences.push({ text: sentence, timestamp: bufferTimestamp, structural: false });
        }
      }
      buffer = "";
      bufferTimestamp = "";
    };

    for (const unit of units) {
      const text = unit.text.trim();
      if (!text) continue;
      if (isBulletLine(text) || isHeadingLine(text)) {
        flush();
        sentences.push({ text, timestamp: unit.timestamp, structural: true });
        continue;
      }
      if (!buffer) bufferTimestamp = unit.timestamp;
      buffer += (buffer && !/[\s([{"“]$/.test(buffer) ? " " : "") + text;
      // A fragment that already ends the sentence should flush immediately
      // so we don't accidentally glue the next caption onto it.
      if (/[.!?]["”)]?\s*$/.test(text)) flush();
    }
    flush();
    return sentences;
  }

  // ---------------------------------------------------------------------
  // Stage 6 — conservative filler removal
  // ---------------------------------------------------------------------

  function removeFillers(text) {
    let value = text;
    // Leading/trailing filler interjections: "Um, so the heart..."
    value = value.replace(/^\s*(?:um+|uh+|uhh+|umm+|hmm+)[,.]?\s+/i, "");
    value = value.replace(/^\s*(?:okay,?\s+so|so,?\s+yeah|alright,?\s+so)[,.]?\s+/i, "");
    // Mid-sentence filler set off by commas: "the heart, um, pumps blood"
    value = value.replace(/\s*,\s*(?:um+|uh+|uhh+|umm+|you know|like)\s*,\s*/gi, ", ");
    // "You know," only when clause-initial and comma-wrapped — meaningful
    // uses ("you know that...", "you know what...") are left untouched.
    value = value.replace(/\byou know,\s+(?!that\b|what\b|which\b|why\b|how\b|who\b|when\b|where\b)/gi, "");
    // Exact immediate word doubling from a caption glitch: "the the heart".
    // Words that are legitimately doubled for emphasis are excluded.
    value = value.replace(/\b(\w+),?\s+\1\b/gi, (match, word) => (/^(very|no|no,|really)$/i.test(word) ? match : word));
    // Exact repeated short phrase (false start), e.g. "the heart pumps, the heart pumps blood".
    value = value.replace(/\b([\w'-]+(?:\s[\w'-]+){1,4}),?\s+\1\b/gi, "$1");
    return value;
  }

  // `when` scopes a rule to a document that's actually on-topic for it
  // (see MEDICAL_RULES above). That check only depends on the whole
  // transcript, not on the individual sentence being cleaned, so it is
  // evaluated once per document rather than once per sentence — testing
  // a `when` regex against the full transcript text inside a per-sentence
  // loop turned every clean into an O(sentences × transcript length)
  // operation, which is what actually froze the tab on a long transcript.
  function selectActiveMedicalRules(context) {
    return MEDICAL_RULES.filter(rule => !rule.when || rule.when.test(context));
  }

  function applyMedicalRules(text, activeRules) {
    let value = text;
    const corrections = [];
    for (const rule of activeRules) {
      rule.find.lastIndex = 0;
      value = value.replace(rule.find, (...args) => {
        const match = args[0];
        const replacement = typeof rule.replace === "function" ? rule.replace(match) : rule.replace;
        corrections.push({ rule: rule.id, original: match, replacement, numeric: Boolean(rule.numeric) });
        return replacement;
      });
    }
    return { text: value, corrections };
  }

  // Runs REVIEW_PATTERNS against one sentence in its document context.
  // Unlike applyMedicalRules, this never changes the text — it only
  // reports a phrase worth a second look, since these are cases where a
  // silent auto-replace is more likely to introduce a wrong "correction"
  // than to fix a real error.
  function findReviewFlags(text, context) {
    const flags = [];
    for (const pattern of REVIEW_PATTERNS) {
      if (!pattern.find.test(text)) continue;
      if (pattern.when && !pattern.when.test(context)) continue;
      if (pattern.unless && pattern.unless.test(context)) continue;
      flags.push(pattern.message);
    }
    return flags;
  }

  // ---------------------------------------------------------------------
  // Stage 7 — punctuation & capitalization
  // ---------------------------------------------------------------------

  function normalizePunctuation(text) {
    let value = String(text || "")
      .replace(/^\s*[,.;:]+\s*/, "")
      .replace(/\s+([,.!?;:])/g, "$1")
      .replace(/([,.!?;:]){2,}/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!value) return value;
    // Capitalize only the first alphabetic character. Never touch the rest
    // of the string, which is what keeps every protected abbreviation
    // (PaCO2, COPD, Na+...) intact regardless of where it sits — except
    // when the sentence *starts* with a protected term whose own casing
    // matters (pH), in which case the term's exact casing wins outright
    // instead of getting force-capitalized.
    const firstAlpha = value.search(/[a-zA-Z]/);
    if (firstAlpha !== -1) {
      const leadingToken = value.slice(firstAlpha).match(/^[A-Za-z][A-Za-z0-9+/-]*/);
      const protectedTerm = leadingToken && PROTECTED_TERMS.find(term => term.toLowerCase() === leadingToken[0].toLowerCase());
      if (protectedTerm) {
        value = value.slice(0, firstAlpha) + protectedTerm + value.slice(firstAlpha + leadingToken[0].length);
      } else {
        value = value.slice(0, firstAlpha) + value[firstAlpha].toUpperCase() + value.slice(firstAlpha + 1);
      }
    }
    if (!/[.!?]["”)]?$/.test(value) && !isBulletLine(value) && !isHeadingLine(value)) value += ".";
    return value;
  }

  // ---------------------------------------------------------------------
  // Stage 8 — section detection
  // ---------------------------------------------------------------------

  function classifySentence(text) {
    // A dismissed topic is not a section announcement. In real lectures a
    // professor often says "we're not going through treatment" immediately
    // before changing subjects; keyword-only classification otherwise puts
    // the entire next topic under a false Treatment heading.
    if (/\b(?:not (?:going to|gonna|covering|discussing)|won't|will not)\b.{0,45}\b(?:go through|cover|discuss|review)\b/i.test(text)) {
      return null;
    }
    if (/\bwaste management (?:company|companies)\b/i.test(text)) return null;
    for (const rule of SECTION_RULES) {
      if (rule.test.test(text)) return rule.id;
    }
    return null;
  }

  function dismissesPreviousTopic(text) {
    return /\b(?:not (?:going to|gonna)|won't|will not)\s+(?:go through|cover|discuss|review)\s+(?:it|that|this)\b/i.test(text);
  }

  function extractEnumeration(sentence) {
    const match = sentence.match(ENUMERATION_LEAD_RE);
    if (!match) return null;
    const lead = match[1].trim();
    const tail = match[2].replace(/\.$/, "").trim();
    const items = tail.split(/,\s*(?:and\s+)?|\s+and\s+/).map(s => s.trim()).filter(Boolean);
    if (items.length >= 3 && items.every(item => item.length > 0 && item.length <= 60 && !/[.!?]$/.test(item) && !/^(?:into|from|of|and|or)\b/i.test(item))) {
      return { lead, items };
    }
    return null;
  }

  // A single sentence that happens to start with "First," is usually just
  // that word used conversationally, not the start of a real list. Only
  // treat a run of ORDINAL_RE matches as an actual numbered sequence once
  // at least two sentences in a row carry an ordinal marker.
  function computeConfirmedOrdinals(sentences) {
    const confirmed = new Array(sentences.length).fill(false);
    let runStart = -1;
    for (let i = 0; i <= sentences.length; i++) {
      const isOrdinal = i < sentences.length && !sentences[i].structural && ORDINAL_RE.test(sentences[i].text);
      if (isOrdinal) {
        if (runStart === -1) runStart = i;
      } else {
        if (runStart !== -1 && i - runStart >= 2) {
          for (let j = runStart; j < i; j++) confirmed[j] = true;
        }
        runStart = -1;
      }
    }
    return confirmed;
  }

  // Groups sentences into { heading, paragraphs, lists } sections.
  // SECTION_RULES is deliberately narrow (see above) so that a match is
  // trustworthy on its own — an explicit topic-announcement sentence like
  // "let's talk about clinical manifestation" should start a section even
  // as a single isolated hit, so this does not require neighbor
  // confirmation the way the ordinal-list check does.
  function detectSections(sentences) {
    const sections = [];
    let current = null;
    const confirmedOrdinals = computeConfirmedOrdinals(sentences);
    const categories = sentences.map((item, index) => {
      if (item.structural) return null;
      const category = classifySentence(item.text);
      const next = sentences[index + 1];
      if (category && next && !next.structural && dismissesPreviousTopic(next.text)) return null;
      return category;
    });

    function ensureSection(headingId) {
      if (current && current.categoryId === headingId) return current;
      const heading = headingId ? SECTION_RULES.find(r => r.id === headingId).heading : null;
      current = { categoryId: headingId, heading, blocks: [] };
      sections.push(current);
      return current;
    }

    for (let i = 0; i < sentences.length; i++) {
      const item = sentences[i];

      if (item.structural) {
        if (isHeadingLine(item.text) && !isBulletLine(item.text)) {
          const label = item.text.replace(/^#{1,3}\s+/, "").replace(/:$/, "");
          current = { categoryId: `custom-${sections.length}`, heading: label, blocks: [] };
          sections.push(current);
        } else {
          if (!current) ensureSection(null);
          current.blocks.push({ type: "bullet", text: item.text.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "") });
        }
        continue;
      }

      const category = categories[i];
      if (category && category !== (current && current.categoryId)) {
        ensureSection(category);
      } else if (!current) {
        ensureSection(null);
      }

      const enumeration = extractEnumeration(item.text);
      if (enumeration) {
        current.blocks.push({ type: "paragraph", text: enumeration.lead + ":" });
        for (const listItem of enumeration.items) current.blocks.push({ type: "bullet", text: listItem.replace(/\.$/, "") });
        continue;
      }

      if (EMPHASIS_RE.test(item.text)) {
        current.blocks.push({ type: "quote", text: item.text });
        continue;
      }

      if (confirmedOrdinals[i]) {
        const ordinalMatch = item.text.match(ORDINAL_RE);
        current.blocks.push({ type: "numbered", text: item.text.slice(ordinalMatch[0].length) });
        continue;
      }

      const last = current.blocks[current.blocks.length - 1];
      if (last && last.type === "paragraph" && last.sentenceCount < 4) {
        last.text += " " + item.text;
        last.sentenceCount += 1;
      } else {
        current.blocks.push({ type: "paragraph", text: item.text, sentenceCount: 1 });
      }
    }

    return sections.filter(section => section.blocks.length > 0);
  }

  // ---------------------------------------------------------------------
  // Stage 9 — title inference
  // ---------------------------------------------------------------------

  const GENERIC_TITLE_WORDS = new Set(["lecture", "notes", "class", "recording", "transcript", "today", "session"]);

  function cleanTitleText(title) {
    let cleaned = String(title || "")
      .replace(/^#{1,3}\s*/, "")
      .replace(/\*\*/g, "")
      .replace(/[_]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[-–—]\s*(?:cleaned|notes?)$/i, "")
      .replace(/^(?:lecture on|today'?s? lecture on|topic:)\s*/i, "")
      .trim();
    if (!cleaned) return "";
    const acronyms = new Set(["ABG", "ARDS", "COPD", "DKA", "GERD", "HIV", "ICU", "V/Q", "PTH", "NCLEX", "CHF", "CAD", "UTI", "DVT"]);
    return cleaned.split(/\s+/).map(word => {
      const bare = word.replace(/[^A-Za-z0-9/]/g, "").toUpperCase();
      if (acronyms.has(bare)) return word.replace(/[A-Za-z0-9/]+/, bare);
      if (/^\d/.test(word)) return word;
      return word.split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join("-");
    }).join(" ");
  }

  function scorePhraseFrequency(sentences) {
    const counts = new Map();
    for (const item of sentences) {
      if (item.structural) continue;
      const words = item.text.replace(/[^A-Za-z0-9\s-]/g, "").split(/\s+/).filter(Boolean);
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i + n <= words.length; i++) {
          const phrase = words.slice(i, i + n);
          if (phrase.some(w => GENERIC_TITLE_WORDS.has(w.toLowerCase()))) continue;
          if (phrase.some(w => /^\d+$/.test(w))) continue;
          if (!phrase.some(w => /^[A-Z]/.test(w) || w.length > 6)) continue;
          const key = phrase.join(" ");
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
    }
    let best = null;
    for (const [phrase, count] of counts.entries()) {
      if (count < 2) continue;
      if (!best || count > best.count || (count === best.count && phrase.length > best.phrase.length)) {
        best = { phrase, count };
      }
    }
    return best ? best.phrase : "";
  }

  function inferTitle(rawText, sentences) {
    const normalized = normalizeInput(rawText);
    const lines = normalized.split("\n").map(l => l.trim()).filter(Boolean);

    // 1. An explicit markdown-style heading near the top.
    const heading = lines.slice(0, 15).find(line => /^#{1,2}\s+\S/.test(line) && !/cleaned lecture/i.test(line));
    if (heading) return { title: cleanTitleText(heading), source: "heading" };

    // 2. A spoken cue: "Today's lecture is about...", "We're going to discuss...".
    for (const line of lines.slice(0, 40)) {
      const match = line.match(/\b(?:today(?:'s)?(?: lecture)? (?:is|covers?|is about)|we(?:'re| are) (?:going to )?(?:cover|discuss|talk about)|lecture (?:is )?on|this lecture (?:is )?(?:covers?|about))\s+([^.!?]{3,80})/i);
      if (match) return { title: cleanTitleText(match[1]), source: "spoken" };
    }

    // 3. Score recurring medically-meaningful phrases across the cleaned sentences.
    const phrase = scorePhraseFrequency(sentences);
    if (phrase) return { title: cleanTitleText(phrase), source: "content" };

    // 4. Fall back to a short descriptive placeholder rather than guessing.
    return { title: "Cleaned Lecture", source: "fallback" };
  }

  // ---------------------------------------------------------------------
  // Stage 10 — Markdown generation
  // ---------------------------------------------------------------------

  function capitalizeFirst(text) {
    const index = text.search(/[a-zA-Z]/);
    if (index === -1) return text;
    return text.slice(0, index) + text[index].toUpperCase() + text.slice(index + 1);
  }

  // Bullets and numbered items render as a single tight list (one newline
  // between items) rather than each item getting its own blank-line
  // paragraph gap — otherwise a five-item list reads as five disconnected
  // paragraphs instead of a list.
  function renderBlocks(blocks) {
    const segments = [];
    let bulletRun = [];
    let numberedRun = [];
    const flushBullets = () => {
      if (!bulletRun.length) return;
      segments.push(bulletRun.map(text => `- ${text}`).join("\n"));
      bulletRun = [];
    };
    const flushNumbered = () => {
      if (!numberedRun.length) return;
      segments.push(numberedRun.map((text, index) => `${index + 1}. ${capitalizeFirst(text)}`).join("\n"));
      numberedRun = [];
    };
    for (const block of blocks) {
      if (block.type === "bullet") { flushNumbered(); bulletRun.push(block.text); continue; }
      if (block.type === "numbered") { flushBullets(); numberedRun.push(block.text); continue; }
      flushBullets();
      flushNumbered();
      if (block.type === "quote") segments.push(`> **Professor emphasized:** ${block.text}`);
      else segments.push(block.text);
    }
    flushBullets();
    flushNumbered();
    return segments.join("\n\n");
  }

  function generateMarkdown(title, sections) {
    const parts = [`# ${title}`];
    for (const section of sections) {
      if (section.heading) parts.push(`## ${section.heading}`);
      parts.push(renderBlocks(section.blocks));
    }
    return parts.filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n") + "\n";
  }

  // ---------------------------------------------------------------------
  // Stage 11 — filename generation
  // ---------------------------------------------------------------------

  function generateFilename(title) {
    return `${safeFilenameBase(title)}_Cleaned.md`;
  }

  function safeFilenameBase(title) {
    return String(title || "Cleaned Lecture")
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/[^A-Za-z0-9 _-]+/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 90) || "Cleaned_Lecture";
  }

  function generateReviewFilename(title) {
    return `${safeFilenameBase(title)}_Final_Review.txt`;
  }

  // A single upload-ready file for the optional final pass. Keeping the raw
  // transcript beside the cleaned draft lets the reviewer verify medical
  // terms, negations, numbers and units instead of guessing from the draft.
  function generateReviewPackage({ title, cleanedMarkdown, originalTranscript, warnings = [] }) {
    const reviewNotes = warnings.length
      ? warnings.map(item => `- ${item}`).join("\n")
      : "- No automatic warnings were generated. Still verify medical terminology, numbers, units and negations.";
    return [
      "LECTURE CLEANER — FINAL REVIEW FILE",
      `Title: ${String(title || "Cleaned Lecture").trim() || "Cleaned Lecture"}`,
      "",
      "REVIEW INSTRUCTIONS",
      "Compare the cleaned draft with the original Panopto transcript. Correct remaining medical speech-to-text errors and formatting problems without adding unsupported facts. Preserve all numbers, units, negations and professor-emphasized exam points. Return only the finalized lecture note.",
      "",
      "AUTOMATIC REVIEW NOTES",
      reviewNotes,
      "",
      "========== CLEANED DRAFT ==========",
      String(cleanedMarkdown || "").trim(),
      "",
      "========== ORIGINAL PANOPTO TRANSCRIPT ==========",
      String(originalTranscript || "").trim(),
      "",
      "========== END ==========",
      ""
    ].join("\n");
  }

  // ---------------------------------------------------------------------
  // Stage 12 — quality validation (non-blocking, surfaced as warnings)
  // ---------------------------------------------------------------------

  function validateResult({ title, markdown, finalWordCount, originalWordCount, titleSource }) {
    const warnings = [];
    if (!markdown || !markdown.trim()) {
      warnings.push("The cleaned result is empty. The transcript may not have contained recognizable text.");
      return warnings;
    }
    if (titleSource === "fallback") {
      warnings.push("Could not confidently detect a lecture title — a generic title was used. Consider editing it before download.");
    }
    if (originalWordCount > 40 && finalWordCount < originalWordCount * 0.25) {
      warnings.push("A large portion of the transcript was removed. Review the result before relying on it.");
    }
    if (/\d{1,2}:\d{2}(?::\d{2})?/.test(markdown.replace(/^#.*$/gm, ""))) {
      warnings.push("A timestamp-like number may remain in the text — double-check lab values and times.");
    }
    return warnings;
  }

  // ---------------------------------------------------------------------
  // Orchestration
  // ---------------------------------------------------------------------

  function wordCount(text) {
    const trimmed = String(text || "").trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }

  function process(rawText) {
    const normalized = normalizeInput(rawText);
    if (!normalized) {
      return {
        title: "Cleaned Lecture",
        filename: "Cleaned_Lecture.md",
        markdown: "",
        stats: { wordsRemoved: 0, sectionsCreated: 0, finalWordCount: 0, originalWordCount: 0, correctionsApplied: 0, phrasesForReview: 0 },
        warnings: ["Nothing was pasted, so there is nothing to clean."]
      };
    }

    const originalWordCount = wordCount(normalized);
    const { lines: unwrappedLines } = stripOldExportWrapper(normalized.split("\n"));
    const panoptoTitle = detectPanoptoTitle(unwrappedLines);
    const { lines: chromeFreeLines } = stripPanoptoChromeBlock(unwrappedLines);
    const format = detectFormat(chromeFreeLines);
    const { lines: artifactFreeLines } = removeArtifacts(chromeFreeLines);
    const units = segmentTranscript(artifactFreeLines, format);
    const speakerProcessed = processSpeakers(units);
    const sentencesRaw = reconstructSentences(speakerProcessed, format);

    const corrections = [];
    const reviewFlagSet = new Set();
    const activeRules = selectActiveMedicalRules(normalized);
    const cleanedSentences = sentencesRaw.map(item => {
      if (item.structural) return item;
      const filtered = removeFillers(item.text);
      const corrected = applyMedicalRules(filtered, activeRules);
      corrections.push(...corrected.corrections);
      const punctuated = normalizePunctuation(corrected.text);
      for (const flag of findReviewFlags(punctuated, normalized)) reviewFlagSet.add(flag);
      return { ...item, text: punctuated };
    }).filter(item => item.text && item.text.trim());

    const sections = detectSections(cleanedSentences);
    const inferred = inferTitle(rawText, cleanedSentences);
    const title = panoptoTitle.title || inferred.title;
    const titleSource = panoptoTitle.title ? "panopto-header" : inferred.source;
    const markdown = generateMarkdown(title, sections);
    const filename = generateFilename(title);

    const finalWordCount = wordCount(markdown.replace(/^#.*$/gm, ""));
    const wordsRemoved = Math.max(0, originalWordCount - finalWordCount);
    const warnings = validateResult({ title, markdown, finalWordCount, originalWordCount, titleSource });
    if (corrections.some(c => c.numeric)) {
      warnings.push("A numeric value was auto-corrected from a likely captioning error — verify it against the lecture.");
    }
    const reviewFlags = [...reviewFlagSet];
    warnings.push(...reviewFlags);

    return {
      title,
      filename,
      markdown,
      format,
      titleSource,
      reviewFlags,
      stats: {
        wordsRemoved,
        sectionsCreated: sections.filter(s => s.heading).length,
        finalWordCount,
        originalWordCount,
        correctionsApplied: corrections.length,
        phrasesForReview: reviewFlags.length
      },
      warnings
    };
  }

  return {
    process,
    // Exposed for the test suite.
    normalizeInput, detectFormat, segmentTranscript, removeArtifacts, processSpeakers,
    stripOldExportWrapper, stripPanoptoChromeBlock,
    reconstructSentences, splitIntoSentences, removeFillers, selectActiveMedicalRules, applyMedicalRules, findReviewFlags, normalizePunctuation,
    detectSections, inferTitle, detectPanoptoTitle, cleanTitleText, generateMarkdown, generateFilename,
    generateReviewFilename, generateReviewPackage,
    validateResult, PROTECTED_TERMS
  };
});
