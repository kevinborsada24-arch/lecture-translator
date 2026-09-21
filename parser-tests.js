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
  assert.ok(!result.markdown.includes("Chronic Obstructive Pulmonary Disease\n\nCOPD"),
    "the echoed title line should not leak into the body: " + result.markdown);
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
