"use strict";

const els = Object.fromEntries([
  "inputCard", "inputText", "inputCount", "dropHint", "addFileButton", "clearButton", "cleanButton",
  "fileInput", "errorBanner", "resultCard", "titleInput", "resultStats", "resultWarnings",
  "markdownPreview", "downloadButton", "copyButton", "reviewFileButton", "startOverButton", "toast"
].map(id => [id, document.getElementById(id)]));

let result = null;
let toastTimer = null;

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2200);
}

function showError(message) {
  els.errorBanner.textContent = message;
  els.errorBanner.hidden = false;
}

function clearError() {
  els.errorBanner.hidden = true;
  els.errorBanner.textContent = "";
}

function wordCount(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function updateInputState() {
  const text = els.inputText.value;
  const words = wordCount(text);
  const chars = text.length;
  els.inputCount.textContent = words
    ? `${words.toLocaleString()} word${words === 1 ? "" : "s"} · ${chars.toLocaleString()} characters`
    : "0 words";
  els.cleanButton.disabled = !text.trim();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cleanLecture() {
  const raw = els.inputText.value;
  if (!raw.trim()) return;
  clearError();

  els.cleanButton.disabled = true;
  els.cleanButton.classList.add("is-loading");
  els.cleanButton.querySelector(".button-label").textContent = "Cleaning Lecture…";
  els.inputText.disabled = true;

  try {
    // A short, deliberate pause so "Cleaning Lecture…" is readable rather
    // than flashing by — the parser itself is fast even on a long transcript.
    await wait(280);
    result = window.LectureParser.process(raw);
    if (!result.markdown.trim()) {
      throw new Error("This transcript did not produce any readable content.");
    }
    renderResult();
    els.resultCard.hidden = false;
    // The preview's auto-grow measures scrollHeight, which reads as empty
    // while the card is still display:none — so it's re-measured once the
    // card is actually visible and laid out.
    autoGrowMarkdownPreview();
    await wait(10);
    els.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error(error);
    showError("This transcript could not be cleaned. Double-check the paste and try again.");
  } finally {
    els.cleanButton.disabled = !els.inputText.value.trim();
    els.cleanButton.classList.remove("is-loading");
    els.cleanButton.querySelector(".button-label").textContent = "Clean Lecture";
    els.inputText.disabled = false;
  }
}

function renderResult() {
  els.titleInput.value = result.title;

  const s = result.stats;
  const statItems = [
    `${s.wordsRemoved.toLocaleString()} words removed`,
    `${s.sectionsCreated.toLocaleString()} section${s.sectionsCreated === 1 ? "" : "s"} created`,
    `${s.finalWordCount.toLocaleString()} words final`
  ];
  if (s.correctionsApplied) {
    statItems.push(`${s.correctionsApplied.toLocaleString()} term${s.correctionsApplied === 1 ? "" : "s"} auto-corrected`);
  }
  if (s.phrasesForReview) {
    statItems.push(`${s.phrasesForReview.toLocaleString()} phrase${s.phrasesForReview === 1 ? "" : "s"} flagged for review`);
  }
  els.resultStats.innerHTML = statItems.map(item => `<span class="stat">${item}</span>`).join("");

  // "Auto-corrected" means a narrow, high-confidence fix was applied.
  // "Flagged for review" means the opposite: the parser found something
  // that LOOKS like a known speech-to-text error but was too risky to
  // rewrite on its own — these are the ones that actually need a human
  // to check the lecture. Both render in the same warning box since both
  // are things worth reading before trusting the output.
  if (result.warnings && result.warnings.length) {
    const warningNodes = result.warnings.map(warning => {
      const line = document.createElement("div");
      line.textContent = warning;
      return line;
    });
    els.resultWarnings.replaceChildren(...warningNodes);
    els.resultWarnings.hidden = false;
  } else {
    els.resultWarnings.replaceChildren();
    els.resultWarnings.hidden = true;
  }

  els.markdownPreview.value = result.markdown;
  autoGrowMarkdownPreview();
}

// The preview used to be a fixed-height box with its own internal
// scrollbar, so reading a full lecture meant scrolling twice — once for
// the page, once inside the box. Growing it to fit its content means the
// page itself does the scrolling, which is the normal way to read a long
// document.
function autoGrowMarkdownPreview() {
  els.markdownPreview.style.height = "auto";
  els.markdownPreview.style.height = `${els.markdownPreview.scrollHeight + 2}px`;
}

function currentMarkdown() {
  if (!result) return "";
  const title = els.titleInput.value.trim() || result.title;
  const body = els.markdownPreview.value;
  // Keep the visible title input authoritative: if the person edited it,
  // replace the leading "# ..." line rather than duplicating a title.
  return body.replace(/^#\s+.*(?:\n|$)/, `# ${title}\n`);
}

function downloadResult() {
  if (!result) return;
  const title = els.titleInput.value.trim() || result.title;
  const filename = window.LectureParser.generateFilename(title);
  const blob = new Blob([currentMarkdown()], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Cleaned lecture downloaded");
}

function downloadReviewFile() {
  if (!result) return;
  const title = els.titleInput.value.trim() || result.title;
  const contents = window.LectureParser.generateReviewPackage({
    title,
    cleanedMarkdown: currentMarkdown(),
    originalTranscript: els.inputText.value,
    warnings: result.warnings
  });
  const filename = window.LectureParser.generateReviewFilename(title);
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Final review file downloaded");
}

async function copyMarkdown() {
  try {
    await navigator.clipboard.writeText(currentMarkdown());
    showToast("Markdown copied");
  } catch (error) {
    console.error(error);
    showToast("Could not copy — select and copy manually");
  }
}

function startOver() {
  result = null;
  els.resultCard.hidden = true;
  els.inputText.value = "";
  clearError();
  updateInputState();
  els.inputCard.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => els.inputText.focus(), 150);
}

async function loadFile(file) {
  const supported = /\.(txt|md|srt|vtt)$/i.test(file.name) || file.type.startsWith("text/");
  if (!supported) {
    showError("Please choose a TXT, Markdown, SRT or WebVTT file.");
    return;
  }
  els.inputText.value = await file.text();
  updateInputState();
  showToast(`${file.name} added`);
}

els.inputText.addEventListener("input", updateInputState);
els.cleanButton.addEventListener("click", cleanLecture);
els.clearButton.addEventListener("click", () => {
  els.inputText.value = "";
  clearError();
  updateInputState();
  els.inputText.focus();
});
els.addFileButton.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", event => {
  const file = event.target.files && event.target.files[0];
  if (file) loadFile(file);
  event.target.value = "";
});
els.markdownPreview.addEventListener("input", autoGrowMarkdownPreview);
els.downloadButton.addEventListener("click", downloadResult);
els.copyButton.addEventListener("click", copyMarkdown);
els.reviewFileButton.addEventListener("click", downloadReviewFile);
els.startOverButton.addEventListener("click", startOver);

for (const evt of ["dragenter", "dragover"]) {
  els.inputCard.addEventListener(evt, e => {
    e.preventDefault();
    els.inputCard.classList.add("is-dragging");
  });
}
for (const evt of ["dragleave", "drop"]) {
  els.inputCard.addEventListener(evt, e => {
    e.preventDefault();
    if (evt === "dragleave" && els.inputCard.contains(e.relatedTarget)) return;
    els.inputCard.classList.remove("is-dragging");
  });
}
els.inputCard.addEventListener("drop", e => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadFile(file);
});

updateInputState();
