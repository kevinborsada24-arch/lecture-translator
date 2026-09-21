/*
 * Parser test suite for Lecture Cleaner.
 *
 * Plain Node, no dependencies, no build step — matches the rest of the
 * project. Run with: node parser-tests.js
 *
 * These are not exhaustive proofs the parser is "correct" (it can't be —
 * it's a heuristic, rule-based cleaner over free-form speech). They exist
 * to catch regressions in the specific behaviors the parser promises:
 * timestamps come out, medical abbreviations survive, empty input doesn't
 * throw, etc.
 */
"use strict";

const assert = require("assert");
const LectureParser = require("./parser-core.js");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    failed++;
    failures.push({ name, error });
  }
}

// ---------------------------------------------------------------------
// Panopto timestamps
// ---------------------------------------------------------------------

test("Panopto: standalone timestamps are removed from the output", () => {
  const input = [
    "Powered by Panopto",
    "Chronic Obstructive Pulmonary Disease",
    "Auto-generated captions may contain errors.",
    "00:00",
    "Today's lecture is about chronic obstructive pulmonary disease.",
    "00:14",
    "COPD includes chronic bronchitis and emphysema.",
    "00:22",
    "Patients present with dyspnea, chronic cough, and sputum production."
  ].join("\n");
  const result = LectureParser.process(input);
  assert.ok(!/\b\d{1,2}:\d{2}\b/.test(result.markdown), "no bare timestamp should remain: " + result.markdown);
  assert.ok(!/powered by panopto/i.test(result.markdown));
  assert.ok(!/auto-generated captions/i.test(result.markdown));
});

test("Panopto: timestamp glued onto a caption line is stripped, text kept", () => {
  const input = "The heart 00:14 has four chambers and two ventricles that pump blood through the body.";
  const result = LectureParser.process(input);
  assert.ok(!/00:14/.test(result.markdown));
  assert.ok(/four chambers/i.test(result.markdown));
});

test("Panopto: HH:MM:SS format is also removed", () => {
  const input = "01:12:35\nThe kidneys filter roughly one hundred and eighty liters of plasma per day.";
  const result = LectureParser.process(input);
  assert.ok(!/01:12:35/.test(result.markdown));
  assert.ok(/kidneys filter/i.test(result.markdown));
});

// ---------------------------------------------------------------------
// Fragmented captions
// ---------------------------------------------------------------------

test("Fragmented captions: sentence split across many caption bursts is rejoined", () => {
  const input = [
    "00:01", "So the",
    "00:02", "pancreas releases",
    "00:03", "insulin in response",
    "00:04", "to rising blood glucose levels after a meal."
  ].join("\n");
  const result = LectureParser.process(input);
  assert.ok(/pancreas releases insulin in response to rising blood glucose levels after a meal\./i.test(result.markdown),
    "fragments should merge into one sentence: " + result.markdown);
});

test("Fragmented captions: a bullet line is not merged into surrounding prose", () => {
  const input = [
    "00:01", "Risk factors for COPD include the following.",
    "00:02", "- Smoking",
    "00:03", "- Alpha-1 antitrypsin deficiency",
    "00:04", "- Occupational dust exposure"
  ].join("\n");
  const result = LectureParser.process(input);
  assert.ok(/-\s*Smoking/.test(result.markdown));
  assert.ok(/-\s*Alpha-1 antitrypsin deficiency/.test(result.markdown));
  assert.ok(!/Smoking - Alpha-1/.test(result.markdown), "bullets should stay separate lines: " + result.markdown);
});

// ---------------------------------------------------------------------
// Multiple speakers
// ---------------------------------------------------------------------

test("Speakers: a single repeated speaker label is dropped entirely", () => {
  const input = [
    "Professor: Today we're covering pleural effusion.",
    "Professor: It's a buildup of fluid in the pleural space."
  ].join("\n");
  const result = LectureParser.process(input);
  assert.ok(!/professor:/i.test(result.markdown), "single-speaker label should be stripped: " + result.markdown);
});

test("Speakers: two distinct speakers get normalized markers", () => {
  const input = [
    "Professor: Can anyone tell me a sign of hypokalemia?",
    "Speaker 1: Muscle weakness?",
    "Professor: Exactly, muscle weakness and possible arrhythmias."
  ].join("\n");
  const result = LectureParser.process(input);
  assert.ok(/\*\*Professor:\*\*/.test(result.markdown));
  assert.ok(/\*\*Speaker 1:\*\*/.test(result.markdown));
});

// ---------------------------------------------------------------------
// Medical abbreviations
// ---------------------------------------------------------------------

test("Abbreviations: pH, PaCO2, COPD, ARDS, V/Q, Na+, K+ survive untouched", () => {
  const input = "Normal pH is 7.35 to 7.45. PaCO2, COPD, ARDS, V/Q mismatch, Na+ and K+ are all things we track closely.";
  const result = LectureParser.process(input);
  for (const term of ["pH", "PaCO2", "COPD", "ARDS", "V/Q", "Na+", "K+"]) {
    assert.ok(result.markdown.includes(term), `expected "${term}" to survive verbatim: ${result.markdown}`);
  }
});

test("Abbreviations: sentence-starting capitalization doesn't corrupt an abbreviation", () => {
  const input = "COPD is a progressive disease. pH must stay within a narrow range or the patient decompensates.";
  const result = LectureParser.process(input);
  assert.ok(result.markdown.includes("COPD is a progressive disease"));
  assert.ok(/\bpH\b/.test(result.markdown), "pH should not become Ph: " + result.markdown);
});

// ---------------------------------------------------------------------
// Medication doses / lab values
// ---------------------------------------------------------------------

test("Medication doses: units and numbers are preserved", () => {
  const input = "The patient received furosemide 40 mg IV push and potassium chloride 20 mEq/L over four hours.";
  const result = LectureParser.process(input);
  assert.ok(result.markdown.includes("40 mg"));
  assert.ok(result.markdown.includes("20 mEq/L"));
});

test("Lab values: decimal values are not split into separate sentences", () => {
  const input = "A normal HCO3- is 22 to 26 mEq/L, and normal pH is 7.35 to 7.45 in an arterial blood gas.";
  const result = LectureParser.process(input);
  assert.ok(result.markdown.includes("7.35 to 7.45"), "decimal range should stay intact: " + result.markdown);
});

// ---------------------------------------------------------------------
// Negations
// ---------------------------------------------------------------------

test("Negations: qualifiers like not, except, increased, decreased, may are preserved", () => {
  const input = "Aldosterone is not decreased in this condition; it may in fact be increased, except during early compensation.";
  const result = LectureParser.process(input);
  for (const word of ["not", "except", "increased", "decreased", "may"]) {
    assert.ok(new RegExp(`\\b${word}\\b`, "i").test(result.markdown), `expected "${word}" to survive: ${result.markdown}`);
  }
});

// ---------------------------------------------------------------------
// Repeated phrases
// ---------------------------------------------------------------------

test("Repeated phrases: an exact caption-glitch repeat collapses to one", () => {
  const input = "The the heart pumps blood through the the body every single day.";
  const result = LectureParser.process(input);
  assert.ok(!/\bthe the\b/i.test(result.markdown), "doubled word should collapse: " + result.markdown);
});

test("Repeated phrases: a deliberate short repeated clause collapses once", () => {
  const input = "The heart pumps blood, the heart pumps blood to every organ in the body.";
  const result = LectureParser.process(input);
  const occurrences = (result.markdown.match(/the heart pumps blood/gi) || []).length;
  assert.ok(occurrences <= 1, "repeated clause should not appear twice: " + result.markdown);
});

// ---------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------

test("Headings: an explicit markdown heading is detected as the title", () => {
  const input = "# Diabetic Ketoacidosis\n\nDKA occurs when the body produces excess ketones due to insufficient insulin.";
  const result = LectureParser.process(input);
  assert.strictEqual(result.title, "Diabetic Ketoacidosis");
});

test("Headings: section headings are generated from clinical structure", () => {
  const input = [
    "Chronic obstructive pulmonary disease is a progressive airflow limitation.",
    "It is caused by long-term exposure to irritants such as cigarette smoke.",
    "Risk factors include smoking and alpha-1 antitrypsin deficiency.",
    "Patients present with dyspnea, chronic cough, and wheezing.",
    "They often show barrel chest and use of accessory muscles.",
    "Treatment includes bronchodilators, corticosteroids, and pulmonary rehab.",
    "Management also involves smoking cessation and oxygen therapy as needed."
  ].join(" ");
  const result = LectureParser.process(input);
  assert.ok(/##\s*Causes/.test(result.markdown), "expected a Causes section: " + result.markdown);
  assert.ok(/##\s*Signs & Symptoms/.test(result.markdown), "expected a Signs & Symptoms section: " + result.markdown);
  assert.ok(/##\s*Treatment/.test(result.markdown), "expected a Treatment section: " + result.markdown);
});

// ---------------------------------------------------------------------
// Poor punctuation
// ---------------------------------------------------------------------

test("Poor punctuation: doubled punctuation and bad spacing are fixed", () => {
  const input = "the heart pumps blood ,,  fast .. it beats about 100000 times a day !!";
  const result = LectureParser.process(input);
  assert.ok(!/,,/.test(result.markdown));
  assert.ok(!/\.\./.test(result.markdown));
  assert.ok(!/!!/.test(result.markdown));
  assert.ok(!/\s,/.test(result.markdown), "no space before comma: " + result.markdown);
});

test("Poor punctuation: sentence beginnings get capitalized", () => {
  const input = "the pancreas is both an endocrine and exocrine organ. it releases insulin and digestive enzymes.";
  const result = LectureParser.process(input);
  assert.ok(/The pancreas is both/.test(result.markdown));
  assert.ok(/It releases insulin/.test(result.markdown));
});

// ---------------------------------------------------------------------
// Very short / very long / empty / no-title transcripts
// ---------------------------------------------------------------------

test("Very short transcript: a single sentence still produces valid markdown", () => {
  const input = "Hyperkalemia is an elevated potassium level in the blood.";
  const result = LectureParser.process(input);
  assert.ok(result.markdown.startsWith("# "));
  assert.ok(result.markdown.includes("Hyperkalemia"));
});

test("Very long transcript: does not throw and produces a reasonable word count", () => {
  const sentence = "The nephron is the functional unit of the kidney and filters blood to form urine every single day. ";
  const input = sentence.repeat(400);
  const result = LectureParser.process(input);
  assert.ok(result.stats.finalWordCount > 0);
  assert.ok(result.markdown.length > 0);
});

test("Empty input: returns a graceful empty result instead of throwing", () => {
  const result = LectureParser.process("");
  assert.strictEqual(result.markdown, "");
  assert.ok(result.warnings.length > 0);
});

test("Whitespace-only input: also handled gracefully", () => {
  const result = LectureParser.process("   \n\n   \n");
  assert.strictEqual(result.markdown, "");
});

test("No obvious title: falls back to a generic title without throwing", () => {
  const input = "Stuff happens in the body sometimes and things change a little bit here and there each day.";
  const result = LectureParser.process(input);
  assert.ok(result.title.length > 0);
  assert.ok(result.warnings.some(w => /generic title/i.test(w)));
});

// ---------------------------------------------------------------------
// Final-review handoff
// ---------------------------------------------------------------------

test("Review package: includes both the edited draft and original transcript", () => {
  const review = LectureParser.generateReviewPackage({
    title: "Kidney Introduction",
    cleanedMarkdown: "# Kidney Introduction\n\nThe nephron filters blood.",
    originalTranscript: "the nephron filters block",
    warnings: ["Verify a numeric value."]
  });
  assert.ok(review.includes("The nephron filters blood."));
  assert.ok(review.includes("the nephron filters block"));
  assert.ok(review.includes("Verify a numeric value."));
  assert.ok(review.includes("without adding unsupported facts"));
});

test("Review package: creates a safe, automatically named text file", () => {
  assert.strictEqual(
    LectureParser.generateReviewFilename("Kidney: Intro / GFR"),
    "Kidney_Intro_GFR_Final_Review.txt"
  );
});

// ---------------------------------------------------------------------
// SRT / WebVTT
// ---------------------------------------------------------------------

test("SRT format: range timestamps and sequence numbers are removed", () => {
  const input = [
    "1",
    "00:00:01,000 --> 00:00:04,000",
    "The liver metabolizes most drugs",
    "",
    "2",
    "00:00:04,000 --> 00:00:07,000",
    "through first-pass hepatic metabolism."
  ].join("\n");
  const result = LectureParser.process(input);
  assert.ok(!/-->/.test(result.markdown));
  assert.ok(!/00:00:0/.test(result.markdown));
  assert.ok(/liver metabolizes most drugs through first-pass hepatic metabolism/i.test(result.markdown));
});

test("WebVTT format: WEBVTT header and cue settings are stripped", () => {
  const input = [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:03.000 align:start position:0%",
    "Insulin lowers blood glucose by promoting cellular uptake."
  ].join("\n");
  const result = LectureParser.process(input);
  assert.ok(!/WEBVTT/.test(result.markdown));
  assert.ok(!/align:start/.test(result.markdown));
  assert.ok(/Insulin lowers blood glucose/.test(result.markdown));
});

// ---------------------------------------------------------------------
// Panopto's repeated title line
// ---------------------------------------------------------------------

test("Panopto: the title echoed after the player header is used as the title, not left in the body", () => {
  const input = [
    "Powered by Panopto",
    "Chronic Obstructive Pulmonary Disease",
    "Auto-generated captions may contain errors.",
    "00:00",
    "COPD is a progressive airflow limitation caused by long-term smoking."
  ].join("\n");
  const result = LectureParser.process(input);
  assert.strictEqual(result.title, "Chronic Obstructive Pulmonary Disease");
  const bodyOnly = result.markdown.replace(/^#[^\n]*\n/, "");
  assert.ok(!bodyOnly.includes("Chronic Obstructive Pulmonary Disease"),
    "the echoed title line should not also appear duplicated in the body: " + result.markdown);
});

// ---------------------------------------------------------------------
// Known speech-to-text error corrections
// ---------------------------------------------------------------------

test("Corrections: known ASR errors on medical terms are fixed", () => {
  const input = "Respiratory acidosis happens when the lungs cannot blow off enough camera dioxide, and normal pH is 7.35 to 2745.";
  const result = LectureParser.process(input);
  assert.ok(result.markdown.includes("carbon dioxide"), "camera dioxide should become carbon dioxide: " + result.markdown);
  assert.ok(result.markdown.includes("7.35 to 7.45"), "the pH range should be corrected: " + result.markdown);
  assert.ok(result.warnings.some(w => /numeric value was auto-corrected/i.test(w)));
});

// ---------------------------------------------------------------------
// Previously-exported wrapper / arbitrary Panopto chrome block
// ---------------------------------------------------------------------

test("Old export wrapper: a re-pasted previous cleaned output doesn't become a giant bogus heading", () => {
  const input = [
    "# ASthma",
    "## Cleaned Lecture Transcript",
    "",
    "> Cleaned from a Buzz/Whisper transcript. Timestamps and professor wording/repetition are retained as much as possible.",
    "",
    "Powered by Panopto",
    "Asthma",
    "Auto-generated captions may contain errors.",
    "0:00",
    "Asthma is a reversible obstructive airway disease."
  ].join("\n");
  const result = LectureParser.process(input);
  assert.strictEqual(result.title, "Asthma");
  assert.ok(!/Cleaned Lecture Transcript/i.test(result.markdown), "old wrapper subheading should not appear: " + result.markdown);
  assert.ok(!/Cleaned from a/i.test(result.markdown), "old wrapper disclaimer should not appear: " + result.markdown);
});

test("Chrome block: an arbitrary chapter list between the header and the transcript is dropped by position, not by name", () => {
  const input = [
    "Powered by Panopto",
    "Acute Respiratory Distress Syndrome",
    "Search this transcript",
    "Details",
    "Contents",
    "Chapters",
    "Introduction 0:00",
    "Pathophysiology 5:32",
    "PEEP and Ventilation 15:47",
    "Auto-generated captions may contain errors.",
    "0:00",
    "ARDS is caused by diffuse alveolar damage and surfactant dysfunction."
  ].join("\n");
  const result = LectureParser.process(input);
  assert.strictEqual(result.title, "Acute Respiratory Distress Syndrome");
  assert.ok(!/Introduction/.test(result.markdown), "chapter list titles are chrome, not content: " + result.markdown);
  assert.ok(!/\d{1,2}:\d{2}/.test(result.markdown), "chapter timestamps should not remain: " + result.markdown);
  assert.ok(/diffuse alveolar damage/.test(result.markdown));
});

// ---------------------------------------------------------------------
// Numbered lists vs. ordinary speech
// ---------------------------------------------------------------------

test("Numbered lists: a lone sentence starting with 'Then' is not turned into a list", () => {
  const input = "The professor drew a diagram on the board. Then we have the bronchospasm and inflammation to consider as well.";
  const result = LectureParser.process(input);
  assert.ok(!/^\d+\.\s/m.test(result.markdown), "a single 'Then' sentence should stay prose: " + result.markdown);
});

test("Numbered lists: two consecutive 'Then' sentences still don't become a list", () => {
  const input = "Then most certainly vaccine for any determination. Then you have it again, maybe one hour, one day, and then you have it again the same.";
  const result = LectureParser.process(input);
  assert.ok(!/^\d+\.\s/m.test(result.markdown), "'Then' is a narrative connector, not an enumerated sequence: " + result.markdown);
});

test("Numbered lists: a real First/Second/Third sequence is rendered as a numbered list", () => {
  const input = "There are three steps to treating an asthma attack. First, give a short-acting bronchodilator. Second, add an anticholinergic if needed. Third, add oral steroids if there is no response.";
  const result = LectureParser.process(input);
  assert.ok(/1\.\s+Give a short-acting bronchodilator/.test(result.markdown), "expected a numbered list: " + result.markdown);
  assert.ok(/2\.\s+Add an anticholinergic/.test(result.markdown));
  assert.ok(/3\.\s+Add oral steroids/.test(result.markdown));
});

// ---------------------------------------------------------------------
// Real-world messy transcript regressions (Panopto chrome + bookmark row)
// ---------------------------------------------------------------------

test("Artifacts: a bare 'search' chrome line is removed", () => {
  const input = "Powered by Panopto\nAsthma\nSearch this recording\nsearch\nAuto-generated captions may contain errors.\nAsthma is a reversible obstructive airway disease.";
  const result = LectureParser.process(input);
  assert.ok(!/\bsearch\b/i.test(result.markdown), "the bare 'search' line should not leak into the body: " + result.markdown);
});

test("Artifacts: a trailing row of bare bookmark timestamps is dropped, not left verbatim", () => {
  const input = "Asthma is caused by chronic airway inflammation and bronchoconstriction.\n0:09 1:57 12:18 13:12";
  const result = LectureParser.process(input);
  assert.ok(!/\d{1,2}:\d{2}/.test(result.markdown), "a line of only timestamps should be dropped entirely: " + result.markdown);
});

// ---------------------------------------------------------------------
// Review flags for risky, ambiguous speech-to-text confusions
// ---------------------------------------------------------------------
// These are terms the parser deliberately does NOT auto-correct, because
// each one is also a real independent medical term — a blind replace
// risks turning a correct statement into a wrong one. They're flagged for
// the person to verify instead.

test("Review flags: hypocalcemia near CO2/respiratory language is flagged, not silently rewritten", () => {
  const input = "The patient has hypocalcemia because the lungs cannot blow off enough carbon dioxide, leading to respiratory failure.";
  const result = LectureParser.process(input);
  assert.ok(result.markdown.includes("hypocalcemia"), "should not be silently rewritten: " + result.markdown);
  assert.ok(result.reviewFlags.some(f => /hypercapnia/i.test(f)));
});

test("Review flags: hypocalcemia in a genuine calcium/parathyroid lecture is NOT flagged", () => {
  const input = "Hypocalcemia occurs when parathyroid hormone is low, causing decreased calcium absorption and a positive Chvostek sign.";
  const result = LectureParser.process(input);
  assert.strictEqual(result.reviewFlags.length, 0, "a real calcium lecture should not be flagged: " + JSON.stringify(result.reviewFlags));
});

test("Review flags: cadmium in a respiratory context is flagged as a likely carbon dioxide mix-up", () => {
  const input = "Cadmium is hiding in the body causing gas exchange problems in the lungs.";
  const result = LectureParser.process(input);
  assert.ok(result.reviewFlags.some(f => /carbon dioxide/i.test(f)));
});

test("Review flags: acetone in an acid-base discussion is flagged, but a real DKA mention is not", () => {
  const acidBase = LectureParser.process("So Mr. Jones has acetone because carbon dioxide is high, and the pH drops.");
  assert.ok(acidBase.reviewFlags.some(f => /acidosis/i.test(f)));
  const dka = LectureParser.process("In diabetic ketoacidosis, acetone breath is a classic finding from ketone production.");
  assert.strictEqual(dka.reviewFlags.length, 0, "a real DKA/acetone-breath mention should not be flagged: " + JSON.stringify(dka.reviewFlags));
});

test("Review flags: ARDS with PEEP/surfactant/hyaline terminology is flagged for a close read", () => {
  const input = "ARDS causes diffuse alveolar damage. PEEP and surfactant therapy are used with concern for hyaline membrane formation.";
  const result = LectureParser.process(input);
  assert.ok(result.reviewFlags.some(f => /PEEP\/surfactant\/hyaline/i.test(f)));
});

// ---------------------------------------------------------------------
// Safe, unambiguous abbreviation corrections
// ---------------------------------------------------------------------

test("Corrections: EV1/FCC/PFC are corrected to FEV₁/FVC/PFT in a pulmonary-function context", () => {
  const result = LectureParser.process("Right now, if you check yours, its EV1 to FCC ratio on the pulmonary function test.");
  assert.ok(result.markdown.includes("FEV₁"), "expected FEV₁: " + result.markdown);
  assert.ok(result.markdown.includes("FVC"), "expected FVC: " + result.markdown);
});

test("Corrections: PFC is corrected to PFT when spirometry values are present", () => {
  const result = LectureParser.process("The PFC showed an obstructive pattern with reduced FEV1.");
  assert.ok(result.markdown.includes("PFT"), "expected PFT: " + result.markdown);
});

test("Corrections: exact respiratory caption failures are repaired in respiratory context", () => {
  const input = "Carbon dioxide is a weak asset. The cilia form a miracle ciliary escalator. COPD hyperinflation creates a barren chance.";
  const result = LectureParser.process(input);
  assert.ok(/weak acid/i.test(result.markdown), result.markdown);
  assert.ok(/mucociliary escalator/i.test(result.markdown), result.markdown);
  assert.ok(/barrel chest/i.test(result.markdown), result.markdown);
});

test("Corrections: paired hypercapnia caption failure is repaired only when the full cue is present", () => {
  const input = "In respiratory failure we have hypocalcemia. Cadmium means carbon dioxide, so the blood level rises.";
  const result = LectureParser.process(input);
  assert.ok(/hypercapnia/i.test(result.markdown), result.markdown);
  assert.ok(/Capnia means carbon dioxide/i.test(result.markdown), result.markdown);
  const calcium = LectureParser.process("Hypocalcemia can result from low parathyroid hormone and low vitamin D.");
  assert.ok(/Hypocalcemia/.test(calcium.markdown), calcium.markdown);
});

test("Corrections: exact acid-base caption failures are repaired", () => {
  const input = "In acid-base balance, if the p h is below 7.35, we call it acetone sits. If it is above 7.45, it's a cannot take. Hyperventilation keeps the carbon dioxide during compensation.";
  const result = LectureParser.process(input);
  assert.ok(/pH is below 7\.35/.test(result.markdown), result.markdown);
  assert.ok(/we call it acidosis/i.test(result.markdown), result.markdown);
  assert.ok(/we call it alkalosis/i.test(result.markdown), result.markdown);
  assert.ok(/hypoventilation retains carbon dioxide/i.test(result.markdown), result.markdown);
});

test("Corrections: exact pneumothorax and ARDS caption failures are repaired", () => {
  const pneumothorax = LectureParser.process("In the pleural cavity this no more tracks represents a pneumothorax and collapsed lung.");
  assert.ok(!/no more tracks/i.test(pneumothorax.markdown), pneumothorax.markdown);
  assert.ok(/pneumothorax/i.test(pneumothorax.markdown), pneumothorax.markdown);

  const ards = LectureParser.process("ARDS releases histamine and Brando priming. Protein creates a higher name memory. PEEP means positive in explanatory pressure on the ventilator.");
  assert.ok(/bradykinin/i.test(ards.markdown), ards.markdown);
  assert.ok(/hyaline membrane/i.test(ards.markdown), ards.markdown);
  assert.ok(/positive end-expiratory pressure/i.test(ards.markdown), ards.markdown);
});

test("Corrections: common nephron anatomy caption failures are repaired", () => {
  const input = "The kidney nephron contains the Balmain capsule, proximal to balance, loop of Henry, restart to release, and glomus. Blood enters through the a friend and leaves through the efferent arteriole.";
  const result = LectureParser.process(input);
  assert.ok(/Bowman's capsule/i.test(result.markdown), result.markdown);
  assert.ok(/proximal tubule/i.test(result.markdown), result.markdown);
  assert.ok(/loop of Henle/i.test(result.markdown), result.markdown);
  assert.ok(/distal tubules/i.test(result.markdown), result.markdown);
  assert.ok(/glomerulus/i.test(result.markdown), result.markdown);
  assert.ok(/afferent arteriole/i.test(result.markdown), result.markdown);
});

test("Corrections: common kidney output, lab, and unit caption failures are repaired", () => {
  const input = "The kidney has low during output and high blood loss. Preload and stroke volume fall, so Project output changes. Normally urine is 1 to 2 million or 800ml to 2000mg. GFR is 120 milligram per minute. We measure serum platinum and serum un. During three hours the urine was 16 millimeter, predicting 480 mL per day.";
  const result = LectureParser.process(input);
  assert.ok(/low urine output/i.test(result.markdown), result.markdown);
  assert.ok(/high blood volume/i.test(result.markdown), result.markdown);
  assert.ok(/cardiac output/i.test(result.markdown), result.markdown);
  assert.ok(/1 to 2 liters/i.test(result.markdown), result.markdown);
  assert.ok(/800 mL to 2000 mL/i.test(result.markdown), result.markdown);
  assert.ok(/120 mL\/min/i.test(result.markdown), result.markdown);
  assert.ok(/serum creatinine/i.test(result.markdown), result.markdown);
  assert.ok(/BUN/.test(result.markdown), result.markdown);
  assert.ok(/60 mL/.test(result.markdown), result.markdown);
});

test("Sections: a dismissed treatment topic does not create a false Treatment heading", () => {
  const input = "Here is the surgical treatment. We're not gonna go through it. What we are going to cover is nephron anatomy. First and foremost, kidneys work like a waste management company.";
  const result = LectureParser.process(input);
  assert.ok(!/## Treatment & Management/.test(result.markdown), result.markdown);
});

test("Lists: clause fragments after including are not converted into a false bullet list", () => {
  const input = "The kidney filtered waste material here, including water, into Bowman's capsule, and rid of some of it through excretion.";
  const result = LectureParser.process(input);
  assert.ok(!/^- /m.test(result.markdown), result.markdown);
});

// ---------------------------------------------------------------------
// Filename generation
// ---------------------------------------------------------------------

test("Filename: sanitizes and matches the expected pattern", () => {
  const filename = LectureParser.generateFilename("Chronic Obstructive Pulmonary Disease");
  assert.strictEqual(filename, "Chronic_Obstructive_Pulmonary_Disease_Cleaned.md");
});

test("Filename: strips unsafe characters", () => {
  const filename = LectureParser.generateFilename('Weird: "Title"? / Name*');
  assert.ok(!/[\\/:*?"<>|]/.test(filename), "unsafe characters should be gone: " + filename);
  assert.ok(filename.endsWith("_Cleaned.md"));
});

// ---------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  for (const { name, error } of failures) {
    console.log(`✗ ${name}`);
    console.log(`  ${error.message}\n`);
  }
  process.exitCode = 1;
} else {
  console.log("All parser tests passed.");
}
