"use strict";

const DRAFT_KEY = "lecture-cleaner-draft-v3";
const els = Object.fromEntries([
  "inputView", "processingView", "resultView", "inputSurface", "inputText", "inputMeta", "fileInput",
  "cleanButton", "saveStatus", "processingTitle", "processingDetail", "progressBar", "newButton",
  "copyButton", "downloadButton", "resultTitle", "resultStats", "reviewSection", "reviewCount",
  "reviewList", "transcriptDocument", "searchInput", "changeCount", "changeList", "toast"
].map(id => [id, document.getElementById(id)]));

let result = null;
let sourceFilename = "";
let toastTimer = null;
let saveTimer = null;

function setView(name) {
  for (const view of [els.inputView, els.processingView, els.resultView]) view.classList.remove("is-active");
  els[`${name}View`].classList.add("is-active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2200);
}

function updateInputState() {
  const text = els.inputText.value;
  const hasText = Boolean(text.trim());
  els.cleanButton.disabled = !hasText;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  els.inputMeta.textContent = sourceFilename || (words ? `${words.toLocaleString()} words pasted` : "Paste text or add a file");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (hasText) localStorage.setItem(DRAFT_KEY, text);
      else localStorage.removeItem(DRAFT_KEY);
      els.saveStatus.textContent = hasText ? "Draft saved on this device" : "Nothing leaves your browser";
    } catch { els.saveStatus.textContent = "Private local processing"; }
  }, 250);
}

async function loadFile(file) {
  const supported = /\.(txt|md|srt|vtt)$/i.test(file.name) || file.type.startsWith("text/");
  if (!supported) { showToast("Please choose a TXT, MD, SRT or VTT file"); return; }
  els.inputText.value = await file.text();
  sourceFilename = file.name;
  updateInputState();
  showToast(`${file.name} added`);
  await cleanLecture();
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function cleanLecture() {
  const raw = els.inputText.value;
  if (!raw.trim()) return;
  setView("processing");
  const phases = [
    ["Reading your lecture…", "Detecting Panopto, SRT or WebVTT structure", 23],
    ["Cleaning the transcript…", "Removing player text and rebuilding caption segments", 51],
    ["Checking medical wording…", "Applying high-confidence, context-aware corrections", 76],
    ["Validating the result…", "Confirming timestamps, numbers and review items", 96]
  ];
  for (const [title, detail, progress] of phases) {
    els.processingTitle.textContent = title;
    els.processingDetail.textContent = detail;
    els.progressBar.style.width = `${progress}%`;
    await wait(105);
  }
  try {
    result = window.LectureParser.process(raw, { stripFillers: true });
    els.progressBar.style.width = "100%";
    renderResult();
    await wait(110);
    setView("result");
  } catch (error) {
    console.error(error);
    setView("input");
    showToast("This transcript could not be parsed");
  }
}

function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderResult() {
  els.resultTitle.value = result.title;
  const s = result.stats;
  const reviewTotal = result.reviewItems.length + result.warnings.length;
  const format = result.format === "panopto" ? "Panopto parsed" : `${result.format.toUpperCase()} parsed`;
  const statItems = [
    format,
    `${s.segments.toLocaleString()} segments`,
    `${s.corrections.toLocaleString()} corrections`,
    s.timestampsFound ? `${s.timestampsPreserved}/${s.timestampsFound} timestamps preserved` : "Plain text",
    reviewTotal ? `${reviewTotal} to review` : "No review needed"
  ];
  els.resultStats.innerHTML = statItems.map((item, index) => `<span class="stat ${index === 3 && s.timestampsFound === s.timestampsPreserved ? "stat-ok" : ""}">${escapeHtml(item)}</span>`).join("");
  renderTranscript();
  renderReview();
  renderChanges();
}

function renderTranscript() {
  els.transcriptDocument.innerHTML = result.segments.map(segment => `
    <article class="segment" id="segment-${segment.id}" data-id="${segment.id}">
      <span class="timestamp">${escapeHtml(segment.timestamp || "")}</span>
      <div class="segment-text" contenteditable="true" spellcheck="true" aria-label="Transcript segment ${segment.id}">${escapeHtml(segment.cleaned)}</div>
    </article>`).join("");
  els.transcriptDocument.querySelectorAll(".segment-text").forEach(node => {
    node.addEventListener("input", () => {
      const id = Number(node.closest(".segment").dataset.id);
      const segment = result.segments.find(item => item.id === id);
      if (segment) segment.cleaned = node.textContent.trim();
    });
  });
}

function renderReview() {
  const warningItems = result.warnings.map((message, index) => ({ id: `warning-${index}`, timestamp: "Check", message, text: "", segmentId: null }));
  const items = [...warningItems, ...result.reviewItems];
  els.reviewSection.hidden = items.length === 0;
  els.reviewCount.textContent = items.length;
  els.reviewList.innerHTML = items.map(item => `
    <div class="review-item">
      <span class="review-time">${escapeHtml(item.timestamp || "Text")}</span>
      <div class="review-copy"><strong>${escapeHtml(item.message)}</strong>${item.text ? `<p>${escapeHtml(item.text)}</p>` : ""}</div>
      ${item.segmentId ? `<button class="review-jump" data-segment="${item.segmentId}">Edit wording</button>` : ""}
    </div>`).join("");
  els.reviewList.querySelectorAll(".review-jump").forEach(button => button.addEventListener("click", () => {
    const target = document.getElementById(`segment-${button.dataset.segment}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("is-target");
    void target.offsetWidth;
    target.classList.add("is-target");
    target.querySelector(".segment-text").focus({ preventScroll: true });
  }));
}

function renderChanges() {
  els.changeCount.textContent = `${result.corrections.length} change${result.corrections.length === 1 ? "" : "s"}`;
  els.changeList.innerHTML = result.corrections.length ? result.corrections.map(change => `
    <div class="change-row">
      <span class="review-time">${escapeHtml(change.timestamp || "Text")}</span>
      <span><del>${escapeHtml(change.original)}</del> &nbsp;→&nbsp; <ins>${escapeHtml(change.replacement)}</ins></span>
    </div>`).join("") : `<p class="review-copy">No automatic medical corrections were required.</p>`;
}

function currentCleanedText() {
  return result.segments.map(segment => segment.timestamp ? `[${segment.timestamp}] ${segment.cleaned}` : segment.cleaned).filter(Boolean).join("\n\n");
}

function safeFilename(title) {
  return String(title || "Cleaned Lecture").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "_").slice(0, 90) || "Cleaned_Lecture";
}

function downloadResult() {
  const title = els.resultTitle.value.trim() || "Cleaned Lecture";
  const body = `# ${title}\n\n${currentCleanedText()}\n`;
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFilename(title)}_Cleaned.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Cleaned lecture downloaded");
}

async function copyResult() {
  await navigator.clipboard.writeText(currentCleanedText());
  showToast("Cleaned transcript copied");
}

function startNew() {
  result = null;
  sourceFilename = "";
  els.inputText.value = "";
  els.searchInput.value = "";
  els.progressBar.style.width = "8%";
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
  updateInputState();
  setView("input");
  setTimeout(() => els.inputText.focus(), 120);
}

els.inputText.addEventListener("input", updateInputState);
els.cleanButton.addEventListener("click", cleanLecture);
els.fileInput.addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (file) loadFile(file);
  event.target.value = "";
});
els.newButton.addEventListener("click", startNew);
els.downloadButton.addEventListener("click", downloadResult);
els.copyButton.addEventListener("click", copyResult);
els.resultTitle.addEventListener("input", () => { if (result) result.title = els.resultTitle.value; });
els.searchInput.addEventListener("input", () => {
  const query = els.searchInput.value.trim().toLowerCase();
  els.transcriptDocument.querySelectorAll(".segment").forEach(node => {
    const match = query && node.textContent.toLowerCase().includes(query);
    node.classList.toggle("is-match", Boolean(match));
  });
  if (query) els.transcriptDocument.querySelector(".is-match")?.scrollIntoView({ block: "center" });
});

for (const event of ["dragenter", "dragover"]) document.addEventListener(event, e => {
  e.preventDefault();
  if (els.inputView.classList.contains("is-active")) els.inputSurface.classList.add("is-dragging");
});
for (const event of ["dragleave", "drop"]) document.addEventListener(event, e => {
  e.preventDefault();
  if (event === "dragleave" && e.relatedTarget) return;
  els.inputSurface.classList.remove("is-dragging");
});
document.addEventListener("drop", e => {
  if (!els.inputView.classList.contains("is-active")) return;
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

try {
  const draft = localStorage.getItem(DRAFT_KEY);
  if (draft) { els.inputText.value = draft; els.saveStatus.textContent = "Draft restored from this device"; }
} catch {}
updateInputState();
