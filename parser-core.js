(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LectureParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SINGLE_TIMESTAMP_RE = /^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?$/;
  const RANGE_TIMESTAMP_RE = /^(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)(?:\s+.*)?$/;
  const TIMESTAMP_RE = SINGLE_TIMESTAMP_RE;
  const PANOPTO_MARKERS = new Set([
    "powered by panopto", "search this recording", "search", "details", "contents",
    "captions", "discussion", "notes", "bookmarks", "hide",
    "auto-generated captions may contain errors."
  ]);
  const EXISTING_WRAPPER_RE = /^(?:#{1,2}\s+cleaned lecture transcript|>\s*cleaned from a (?:buzz|whisper|panopto) transcript.*)$/i;

  // Only strong, repeatable corrections belong here. Ambiguous wording is
  // surfaced for review instead of being silently rewritten.
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
    { id: "ards-art", find: /\barts?\b/gi, replace: "ARDS", when: /acute respiratory distress|refractory hypoxemia|respiratory distress syndrome/i, confidence: 0.95 }
  ];

  const REVIEW_PATTERNS = [
    { find: /\bpromoter acts?\b/i, message: "Possible corrupted medical phrase near ‘promoter acts’." },
    { find: /\bbiogenic\b/i, message: "‘Biogenic’ may be a captioning error in this context." },
    { find: /\burine audio\b/i, message: "Possible corrupted electrolyte or urine-output phrase." },
    { find: /\bascend recorded\b/i, message: "Possible corrupted fluid-compartment term." },
    { find: /\bnormalize insulin\b/i, message: "Possible corrupted insulin-treatment phrase." },
    { find: /\bnitric oxide A\b/i, message: "Possible corrupted therapy or gas name." },
    { find: /\b(?:sodium|potassium)\b.{0,60}\binsulin\b|\binsulin\b.{0,60}\b(?:sodium|potassium)\b/i, message: "Verify whether insulin is referring to potassium shifting into cells." },
    { find: /\bpH\b.{0,30}\b\d{3,}\b/i, message: "Verify the pH value; the caption may have merged a decimal." }
  ];

  const TOPICS = [
    { title: "Acid–Base Balance", topic: "Acid–base", terms: [/\bacid.?base\b/gi, /\brespiratory acidosis\b/gi, /\bmetabolic alkalosis\b/gi, /\bABG\b/g] },
    { title: "Calcium Imbalances", topic: "Endocrine", terms: [/\bcalcium\b/gi, /\bparathyroid\b/gi, /\bosteoclast/gi] },
    { title: "Potassium Imbalances", topic: "Electrolytes", terms: [/\bpotassium\b/gi, /\bhyperkalemia\b/gi, /\bhypokalemia\b/gi] },
    { title: "Sodium Imbalances", topic: "Electrolytes", terms: [/\bsodium\b/gi, /\bhyponatremia\b/gi, /\bhypernatremia\b/gi] },
    { title: "Fluid Volume Deficit", topic: "Fluids", terms: [/\bvolume deficit\b/gi, /\bhypovolemia\b/gi, /\bdehydration\b/gi] },
    { title: "Pleural Effusion", topic: "Respiratory", terms: [/\bpleural effusion\b/gi, /\btransudate\b/gi, /\bexudate\b/gi] },
    { title: "Pneumothorax", topic: "Respiratory", terms: [/\bpneumothorax\b/gi, /\btension pneumothorax\b/gi, /\bpleural cavity\b/gi] },
    { title: "ARDS", topic: "Respiratory", terms: [/\bARDS\b/g, /\bacute respiratory distress syndrome\b/gi, /\brefractory hypoxemia\b/gi] },
    { title: "COPD", topic: "Respiratory", terms: [/\bCOPD\b/gi, /\bchronic bronchitis\b/gi, /\bemphysema\b/gi] },
    { title: "Asthma", topic: "Respiratory", terms: [/\basthma\b/gi, /\bbronchoconstriction\b/gi, /\bstatus asthmaticus\b/gi] },
    { title: "Respiratory System Overview", topic: "Respiratory", terms: [/\brespiratory system\b/gi, /\bventilation\b/gi, /\bgas exchange\b/gi] },
    { title: "Heart Failure", topic: "Cardiovascular", terms: [/\bheart failure\b/gi, /\bejection fraction\b/gi, /\bcardiac output\b/gi] },
    { title: "Shock", topic: "Cardiovascular", terms: [/\bhypovolemic shock\b/gi, /\bcardiogenic shock\b/gi, /\bdistributive shock\b/gi] },
    { title: "Kidney Disease", topic: "Renal", terms: [/\bkidney disease\b/gi, /\brenal failure\b/gi, /\bglomerular filtration\b/gi] },
    { title: "Diabetes Mellitus", topic: "Endocrine", terms: [/\bdiabetes mellitus\b/gi, /\binsulin resistance\b/gi, /\bhyperglycemia\b/gi] },
    { title: "Cancer and Neoplasia", topic: "Cellular", terms: [/\bneoplasia\b/gi, /\bmalignan(?:t|cy)\b/gi, /\bmetastasis\b/gi] }
  ];

  function normalizeNewlines(text) {
    return String(text || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/\u200b/g, "");
  }

  function cleanTitle(title) {
    const cleaned = String(title || "").replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/[_]+/g, " ")
      .replace(/\s+/g, " ").replace(/[-–—]+\s*cleaned$/i, "").trim();
    if (!cleaned) return "";
    const acronyms = new Set(["ABG", "ARDS", "COPD", "DKA", "GERD", "HIV", "ICU", "VQ", "PTH"]);
    return cleaned.split(/\s+/).map(word => {
      const bare = word.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (acronyms.has(bare)) return word.replace(/[A-Za-z0-9]+/, bare);
      if (/^\d+(?:[./-]\d+)*$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(" ");
  }

  function stripExistingExportWrapper(lines) {
    const output = [...lines];
    if (output[0] && /^#\s+/.test(output[0])) output.shift();
    while (output.length && (!output[0].trim() || EXISTING_WRAPPER_RE.test(output[0].trim()))) output.shift();
    return output;
  }

  function detectPanoptoTitle(lines) {
    const poweredIndex = lines.findIndex(line => line.trim().toLowerCase() === "powered by panopto");
    if (poweredIndex === -1) return "";
    for (let i = poweredIndex + 1; i < Math.min(lines.length, poweredIndex + 7); i++) {
      const candidate = lines[i].trim();
      if (candidate && !PANOPTO_MARKERS.has(candidate.toLowerCase())) return cleanTitle(candidate);
    }
    return "";
  }

  function removePanoptoChrome(lines) {
    const poweredIndex = lines.findIndex(line => line.trim().toLowerCase() === "powered by panopto");
    if (poweredIndex !== -1) {
      const noticeIndex = lines.findIndex((line, index) => index > poweredIndex && line.trim().toLowerCase() === "auto-generated captions may contain errors.");
      let bodyStart = noticeIndex === -1 ? -1 : noticeIndex + 1;
      if (bodyStart === -1) {
        const firstTimestamp = lines.findIndex((line, index) => index > poweredIndex && SINGLE_TIMESTAMP_RE.test(line.trim()));
        if (firstTimestamp !== -1) bodyStart = Math.max(poweredIndex + 1, firstTimestamp - 1);
      }
      if (bodyStart !== -1) return { lines: [...lines.slice(0, poweredIndex), ...lines.slice(bodyStart)], removed: lines.slice(poweredIndex, bodyStart) };
    }
    const removed = [], kept = [];
    for (const originalLine of lines) {
      const lower = originalLine.trim().toLowerCase();
      if (PANOPTO_MARKERS.has(lower) && !SINGLE_TIMESTAMP_RE.test(originalLine.trim())) removed.push(originalLine);
      else kept.push(originalLine);
    }
    return { lines: kept, removed };
  }

  function normalizeTimestamp(value) {
    return String(value || "").trim().replace(/^\[|\]$/g, "").replace(",", ".");
  }

  function parseTimedCaptions(lines) {
    const format = lines.some(line => /^WEBVTT\b/i.test(line.trim())) ? "vtt" : "srt";
    const segments = [];
    let i = 0;
    while (i < lines.length) {
      const range = lines[i].trim().match(RANGE_TIMESTAMP_RE);
      if (!range) { i++; continue; }
      const start = normalizeTimestamp(range[1]);
      const end = normalizeTimestamp(range[2]);
      i++;
      const caption = [];
      while (i < lines.length && lines[i].trim() && !RANGE_TIMESTAMP_RE.test(lines[i].trim())) {
        if (!/^\d+$/.test(lines[i].trim())) caption.push(lines[i].replace(/<[^>]+>/g, "").trim());
        i++;
      }
      segments.push({ id: segments.length + 1, start, end, timestamp: start, original: caption.join(" ").replace(/\s+/g, " ").trim() });
    }
    return { format, segments, warnings: [] };
  }

  function parsePanoptoCaptions(lines) {
    const segments = [], warnings = [];
    let pending = [];
    for (const originalLine of lines) {
      const line = originalLine.trim();
      if (!line) continue;
      const match = line.match(SINGLE_TIMESTAMP_RE);
      if (match) {
        const caption = pending.join(" ").replace(/\s+/g, " ").trim();
        segments.push({ id: segments.length + 1, start: normalizeTimestamp(match[1]), end: "", timestamp: normalizeTimestamp(match[1]), original: caption });
        if (!caption) warnings.push(`Timestamp ${match[1]} had no caption text and was preserved.`);
        pending = [];
      } else pending.push(line);
    }
    if (pending.length) segments.push({ id: segments.length + 1, start: "", end: "", timestamp: "", original: pending.join(" ").replace(/\s+/g, " ").trim() });
    return { format: "panopto", segments, warnings };
  }

  function parsePlainText(lines) {
    const chunks = lines.join("\n").split(/\n\s*\n+/).map(v => v.replace(/\s+/g, " ").trim()).filter(Boolean);
    return { format: "text", segments: chunks.map((original, index) => ({ id: index + 1, start: "", end: "", timestamp: "", original })), warnings: [] };
  }

  function parseCaptionSegments(lines) {
    if (lines.some(line => RANGE_TIMESTAMP_RE.test(line.trim()))) return parseTimedCaptions(lines);
    if (lines.some(line => SINGLE_TIMESTAMP_RE.test(line.trim()))) return parsePanoptoCaptions(lines);
    return parsePlainText(lines);
  }

  function removeSafeFillers(text) {
    return String(text || "").replace(/^\s*(?:um+|uh+|uhh+|umm+)[,.]?\s+/i, "")
      .replace(/^\s*(?:okay,?\s+so|so,?\s+yeah)[,.]?\s+/i, "")
      .replace(/\s*,\s*(?:um+|uh+|uhh+|umm+)\s*,\s*/gi, ", ");
  }

  function normalizeCaption(text) {
    let value = String(text || "").replace(/^\s*[,.;:]+\s*/, "").replace(/\s+([,.!?;:])/g, "$1")
      .replace(/([,.!?;:]){2,}/g, "$1").replace(/\s+/g, " ").trim();
    if (value) value = value.charAt(0).toUpperCase() + value.slice(1);
    return value;
  }

  function applyMedicalRules(text, documentContext) {
    let value = text;
    const corrections = [];
    for (const rule of MEDICAL_RULES) {
      if (rule.when && !rule.when.test(`${documentContext} ${value}`)) continue;
      rule.find.lastIndex = 0;
      value = value.replace(rule.find, match => {
        corrections.push({ rule: rule.id, original: match, replacement: rule.replace, confidence: rule.confidence, numeric: Boolean(rule.numeric) });
        return rule.replace;
      });
    }
    return { text: value, corrections };
  }

  function findReviewItems(text, segment) {
    const items = [];
    for (const pattern of REVIEW_PATTERNS) {
      pattern.find.lastIndex = 0;
      if (pattern.find.test(text)) items.push({ id: `review-${segment.id}-${items.length}`, segmentId: segment.id, timestamp: segment.timestamp, text, message: pattern.message, type: "language" });
    }
    return items;
  }

  function scoreTopics(text) {
    return TOPICS.map(topic => {
      let score = 0;
      for (const term of topic.terms) { term.lastIndex = 0; score += (text.match(term) || []).length; }
      return { title: topic.title, topic: topic.topic, score };
    }).sort((a, b) => b.score - a.score);
  }

  function inferTitleAndTopic(text) {
    const lines = normalizeNewlines(text).split("\n").map(line => line.trim()).filter(Boolean);
    const heading = lines.find(line => /^#{1,2}\s+\S/.test(line));
    if (heading && !/cleaned lecture transcript/i.test(heading)) return { title: cleanTitle(heading), topic: "General", source: "heading" };
    for (const line of lines.slice(0, 60)) {
      const match = line.match(/\b(?:today(?:'s)?(?: lecture)? (?:is|covers?|is about)|we(?:'re| are) (?:going to )?(?:cover|discuss|talk about)|lecture (?:is )?on)\s+([^.!?]{3,80})/i);
      if (match) return { title: cleanTitle(match[1]), topic: "General", source: "spoken" };
    }
    const best = scoreTopics(text)[0];
    if (best && best.score >= 2) return { title: best.title, topic: best.topic, source: "content" };
    return { title: "Cleaned Lecture", topic: "General", source: "fallback" };
  }

  function renderSegments(segments) {
    return segments.map(segment => segment.timestamp ? `[${segment.timestamp}] ${segment.cleaned}` : segment.cleaned).filter(Boolean).join("\n\n");
  }

  function process(rawText, options) {
    const settings = { stripFillers: true, ...(options || {}) };
    const normalized = normalizeNewlines(rawText);
    let lines = stripExistingExportWrapper(normalized.split("\n"));
    const panoptoTitle = detectPanoptoTitle(lines);
    const chrome = removePanoptoChrome(lines);
    const parsed = parseCaptionSegments(chrome.lines);
    const inferred = inferTitleAndTopic(`${panoptoTitle}\n${normalized}`);
    const title = panoptoTitle || inferred.title;
    const topicScores = scoreTopics(`${title}\n${normalized}`);
    const topic = topicScores[0]?.score ? topicScores[0].topic : inferred.topic;
    const context = `${title} ${topic} ${normalized}`;
    const corrections = [], reviewItems = [];

    const segments = parsed.segments.map(segment => {
      const source = settings.stripFillers ? removeSafeFillers(segment.original) : segment.original;
      const corrected = applyMedicalRules(source, context);
      const cleaned = normalizeCaption(corrected.text);
      const segmentCorrections = corrected.corrections.map(change => ({ ...change, segmentId: segment.id, timestamp: segment.timestamp }));
      corrections.push(...segmentCorrections);
      reviewItems.push(...findReviewItems(cleaned, segment));
      for (const change of segmentCorrections.filter(item => item.numeric)) {
        reviewItems.push({ id: `numeric-${segment.id}-${reviewItems.length}`, segmentId: segment.id, timestamp: segment.timestamp, text: cleaned, message: `Numeric correction applied: “${change.original}” → “${change.replacement}”. Verify against the lecture.`, type: "number" });
      }
      return { ...segment, cleaned, confidence: segmentCorrections.length ? Math.min(...segmentCorrections.map(item => item.confidence)) : 1, changes: segmentCorrections };
    });

    const inputTimestampCount = parsed.format === "srt" || parsed.format === "vtt"
      ? normalized.split("\n").filter(line => RANGE_TIMESTAMP_RE.test(line.trim())).length
      : normalized.split("\n").filter(line => SINGLE_TIMESTAMP_RE.test(line.trim())).length;
    const outputTimestampCount = segments.filter(segment => segment.timestamp).length;
    const warnings = [...parsed.warnings];
    if (inputTimestampCount !== outputTimestampCount) warnings.push(`Timestamp validation failed: found ${inputTimestampCount}, preserved ${outputTimestampCount}.`);

    return {
      title, topic, format: parsed.format, cleanedText: renderSegments(segments), segments, corrections, reviewItems, warnings,
      stats: {
        panoptoDetected: Boolean(panoptoTitle || normalized.toLowerCase().includes("powered by panopto")),
        chromeLinesRemoved: chrome.removed.length, segments: segments.length,
        timestampsFound: inputTimestampCount, timestampsPreserved: outputTimestampCount,
        corrections: corrections.length, reviewItems: reviewItems.length
      }
    };
  }

  return { process, cleanTitle, detectPanoptoTitle, parseCaptionSegments, applyMedicalRules, inferTitleAndTopic, TIMESTAMP_RE, RANGE_TIMESTAMP_RE };
});
