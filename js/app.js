/* =====================================================================
 * 夢見録 — 夢日記 & 夢占い Webアプリ
 *
 * 機能:
 *  ① 内蔵の夢占い辞書（js/dictionary.js）による診断
 *  ② 夢占い本のアップロード（txt/md/csv/json/pdf）→ 独自辞書として参照
 *  ③ 記入 / 音声入力（Web Speech API）した夢の診断（辞書照合 + Claude AI）
 *  ④ 日付つきでブラウザ（localStorage）に保存
 *  ⑤ 夢日記データのダウンロード / アップロード（JSON）
 *  ⑥ Google Drive の所定フォルダから手書き夢日記画像を取得して OCR
 *  ⑦ OCR結果を夢診断し、日記として自動記録
 * ===================================================================== */

"use strict";

/* ---------------- ストレージ ---------------- */

const LS_KEYS = {
  entries: "yumemiroku.entries",
  books: "yumemiroku.books",
  settings: "yumemiroku.settings",
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.warn("localStorage読み込み失敗:", key, e);
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    alert("保存に失敗しました。ブラウザの保存容量（約5MB）を超えている可能性があります。\n不要な本データや古い日記を削除してください。");
    return false;
  }
}

let entries = loadJSON(LS_KEYS.entries, []);   // [{id, date, text, diagnosis, aiDiagnosis, source, createdAt}]
let books = loadJSON(LS_KEYS.books, []);       // [{id, name, addedAt, dict: [{kw, meaning}]}]
let settings = loadJSON(LS_KEYS.settings, {
  apiKey: "",
  model: "claude-opus-4-8",
  gdriveClientId: "",
  gdriveFolder: "夢日記",
  ocrEngine: "claude",
});

const $ = (sel) => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function setStatus(el, msg, kind = "") {
  el.hidden = !msg;
  el.textContent = msg || "";
  el.className = "status-text" + (kind ? " " + kind : "");
}

/* ---------------- タブ ---------------- */

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("#" + btn.dataset.tab).classList.add("active");
  });
});

/* ---------------- 音声入力 (Web Speech API) ---------------- */

let recognition = null;
let recognizing = false;

function setupVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $("#btn-voice");
  const status = $("#voice-status");

  if (!SR) {
    btn.addEventListener("click", () =>
      setStatus(status, "このブラウザは音声入力に対応していません。Chrome / Edge / Safari をお使いください。", "error"));
    return;
  }

  btn.addEventListener("click", () => {
    if (recognizing) { recognition.stop(); return; }

    recognition = new SR();
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = true;

    let finalBuf = "";
    recognition.onstart = () => {
      recognizing = true;
      btn.textContent = "⏹ 音声入力を停止";
      btn.classList.add("recording");
      setStatus(status, "聞き取り中… 夢の内容を話してください。");
    };
    recognition.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalBuf += t;
        else interim += t;
      }
      if (finalBuf) {
        const ta = $("#dream-text");
        // 最後に確定したところまでを反映（重複追記を避けるため一括更新）
        ta.value = ta.dataset.voiceBase + finalBuf;
      }
      setStatus(status, interim ? "認識中: " + interim : "聞き取り中…");
    };
    recognition.onerror = (ev) => {
      setStatus(status, "音声認識エラー: " + ev.error +
        (ev.error === "not-allowed" ? "（マイクの使用を許可してください。https または localhost での実行が必要です）" : ""), "error");
    };
    recognition.onend = () => {
      recognizing = false;
      btn.textContent = "🎤 音声入力を開始";
      btn.classList.remove("recording");
      setStatus(status, "音声入力を終了しました。", "ok");
    };

    const ta = $("#dream-text");
    ta.dataset.voiceBase = ta.value ? ta.value.replace(/\s*$/, "") + "\n" : "";
    recognition.start();
  });
}

/* ---------------- 辞書（内蔵 + アップロード本） ---------------- */

function allDictEntries() {
  const builtin = (window.BUILTIN_DREAM_DICT || []).map((e) => ({
    kw: e.kw, syn: e.syn || [], meaning: e.meaning, fortune: e.fortune || "",
    source: "内蔵辞書",
  }));
  const custom = [];
  for (const b of books) {
    for (const d of b.dict) {
      custom.push({ kw: d.kw, syn: d.syn || [], meaning: d.meaning, fortune: d.fortune || "", source: b.name });
    }
  }
  return builtin.concat(custom);
}

/** 動詞の活用に対応するため、語幹などの照合バリエーションを作る
 *  例: 「歯が抜ける」→「歯が抜け」（「歯が抜けて」にもマッチ） */
function matchVariants(word) {
  const variants = [word];
  if (word.length >= 2 && /[るうくぐすつぬぶむ]$/.test(word)) {
    const stem = word.slice(0, -1);
    // 語幹が2文字以上、または1文字でも漢字なら照合に使う（誤マッチを抑える）
    if (stem.length >= 2 || /[一-龯]/.test(stem)) variants.push(stem);
  }
  return variants;
}

/** 夢テキストに含まれるシンボルを照合する */
function matchSymbols(text) {
  const hits = [];
  const seen = new Set();
  for (const entry of allDictEntries()) {
    const words = [entry.kw, ...(entry.syn || [])].filter((w) => w && w.length >= 1);
    const found = words.find((w) => matchVariants(w).some((v) => text.includes(v)));
    if (found) {
      const key = entry.source + "::" + entry.kw;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({ ...entry, matched: entry.kw });
      }
    }
  }
  // キーワードが長い（=具体的な）ものを先に
  hits.sort((a, b) => b.kw.length - a.kw.length);
  return hits;
}

function fortuneBadge(f) {
  if (!f) return "";
  return `<span class="fortune-badge fortune-${esc(f)}">${esc(f)}</span>`;
}

function localDiagnosisHTML(hits) {
  if (hits.length === 0) {
    return `<h3>🔮 辞書照合の結果</h3>
      <p>辞書に一致するシンボルは見つかりませんでした。夢の中の印象的なもの（動物・場所・行動など）を具体的な言葉で書くと照合しやすくなります。AI夢判断もお試しください。</p>`;
  }
  const counts = { 吉夢: 0, 凶夢: 0, 警告夢: 0, 吉凶混合: 0 };
  for (const h of hits) if (counts[h.fortune] !== undefined) counts[h.fortune]++;
  let overall = "";
  if (counts.吉夢 > counts.凶夢 + counts.警告夢) overall = "全体として<strong>運気の上昇を示す吉夢の傾向</strong>が見られます。";
  else if (counts.凶夢 + counts.警告夢 > counts.吉夢) overall = "全体として<strong>注意を促す警告的な傾向</strong>が見られます。心身の休息や慎重な行動を心がけましょう。";
  else overall = "吉凶が混在しています。夢の中で感じた印象（心地よさ・怖さ）が判断の手がかりになります。";

  const items = hits.slice(0, 12).map((h) => `
    <div class="symbol-hit">
      <span class="sym-name">「${esc(h.matched)}」</span>${fortuneBadge(h.fortune)}
      <span class="sym-src">出典: ${esc(h.source)}</span>
      <div>${esc(h.meaning)}</div>
    </div>`).join("");

  return `<h3>🔮 辞書照合の結果（${hits.length}件のシンボル）</h3>
    <p>${overall}</p>${items}
    ${hits.length > 12 ? `<p class="note">ほか ${hits.length - 12} 件のシンボルが見つかりました。</p>` : ""}`;
}

function localDiagnosisText(hits) {
  if (hits.length === 0) return "辞書に一致するシンボルはありませんでした。";
  return hits.slice(0, 12).map((h) =>
    `【${h.matched}】${h.fortune ? `(${h.fortune}) ` : ""}${h.meaning}（出典: ${h.source}）`).join("\n");
}

/* ---------------- Claude API ---------------- */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

async function callClaude(payload) {
  if (!settings.apiKey) {
    throw new Error("Claude APIキーが設定されていません。「⚙️ 設定」タブでAPIキーを入力してください。");
  }
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = `APIエラー (HTTP ${res.status})`;
    try {
      const err = await res.json();
      if (err?.error?.message) msg += ": " + err.error.message;
    } catch (_) { /* ignore */ }
    if (res.status === 401) msg += "\nAPIキーが正しいか確認してください。";
    if (res.status === 429) msg += "\nしばらく待ってから再度お試しください。";
    throw new Error(msg);
  }
  const data = await res.json();
  if (data.stop_reason === "refusal") {
    throw new Error("AIがこのリクエストへの応答を控えました。内容を変えて再度お試しください。");
  }
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return text.trim();
}

/** AI夢判断: 夢テキスト + 辞書の照合結果を参考資料として渡す */
async function aiDiagnose(dreamText, hits) {
  const reference = hits.length
    ? "参考資料（夢占い辞書・アップロードされた夢占い本からの照合結果）:\n" +
      hits.slice(0, 15).map((h) => `- 「${h.kw}」(${h.fortune || "分類なし"}): ${h.meaning} [出典: ${h.source}]`).join("\n")
    : "（辞書に一致するシンボルはありませんでした）";

  const system = [
    "あなたは経験豊かで思いやりのある夢占い師です。ユーザーが見た夢を日本語で丁寧に読み解きます。",
    "以下の方針に従ってください:",
    "- 提供された参考資料（夢占い辞書やユーザーがアップロードした夢占い本の抜粋)がある場合は、その解釈を尊重し、引用しながら総合的に判断する",
    "- 夢に登場したシンボルごとの意味、夢全体のストーリーが示す心理状態、総合的な吉凶、今後へのアドバイスの順で構成する",
    "- 断定的に不安を煽らず、警告的な内容も前向きな行動指針として伝える",
    "- 医療・法律などの専門判断が必要な内容には、専門家への相談を勧める",
    "- 出力は読みやすい日本語のプレーンテキスト。見出しには絵文字や【】を使ってよいが、Markdown記法(#や*)は使わない",
  ].join("\n");

  const userMsg = `次の夢を診断してください。\n\n夢の内容:\n${dreamText}\n\n${reference}`;

  return callClaude({
    model: settings.model || "claude-opus-4-8",
    max_tokens: 3000,
    system,
    messages: [{ role: "user", content: userMsg }],
  });
}

/** Claude Vision による手書き日記OCR */
async function claudeOCR(base64Data, mediaType) {
  return callClaude({
    model: settings.model || "claude-opus-4-8",
    max_tokens: 3000,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
        { type: "text", text: "この画像は手書きの夢日記です。書かれている日本語の文章を、書かれている通りに全て文字起こししてください。日付が書かれていればそれも含めてください。文字起こしした本文のみを出力し、説明や前置きは不要です。" },
      ],
    }],
  });
}

/* ---------------- Tesseract.js OCR（フォールバック） ---------------- */

let tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (tesseractLoading) return tesseractLoading;
  tesseractLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Tesseract.jsの読み込みに失敗しました（ネットワーク接続を確認してください）"));
    document.head.appendChild(s);
  });
  return tesseractLoading;
}

async function tesseractOCR(fileOrBlob, onProgress) {
  await loadTesseract();
  const result = await window.Tesseract.recognize(fileOrBlob, "jpn", {
    logger: (m) => {
      if (m.status === "recognizing text" && onProgress) onProgress(Math.round(m.progress * 100));
    },
  });
  return result.data.text.trim();
}

/* ---------------- OCR共通 ---------------- */

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result; // data:image/png;base64,....
      const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
      if (m) resolve({ mediaType: m[1], data: m[2] });
      else reject(new Error("画像の読み込みに失敗しました"));
    };
    reader.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
    reader.readAsDataURL(file);
  });
}

async function ocrImage(fileOrBlob, statusEl, label) {
  const engine = settings.ocrEngine || "claude";
  if (engine === "claude" && settings.apiKey) {
    setStatus(statusEl, `${label}: Claude VisionでOCR中…`);
    const { mediaType, data } = await fileToBase64(fileOrBlob);
    return claudeOCR(data, mediaType);
  }
  if (engine === "claude" && !settings.apiKey) {
    setStatus(statusEl, `${label}: APIキー未設定のためTesseract.jsでOCRします…`);
  }
  return tesseractOCR(fileOrBlob, (p) => setStatus(statusEl, `${label}: OCR中… ${p}%`));
}

/** OCRテキストから日付を推定する（見つからなければnull） */
function extractDateFromText(text) {
  const patterns = [
    /(\d{4})[年\/\-\.](\d{1,2})[月\/\-\.](\d{1,2})/,           // 2026年7月12日, 2026/7/12
    /(?:R|令和)\s*(\d{1,2})[年\.\/](\d{1,2})[月\.\/](\d{1,2})/, // 令和8年7月12日
    /(\d{1,2})[月\/](\d{1,2})日?/,                              // 7月12日, 7/12
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = patterns[i].exec(text);
    if (!m) continue;
    let y, mo, d;
    if (i === 0) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if (i === 1) { y = 2018 + +m[1]; mo = +m[2]; d = +m[3]; } // 令和
    else { y = new Date().getFullYear(); mo = +m[1]; d = +m[2]; }
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y > 1900 && y < 2200) {
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  return null;
}

/* ---------------- タブ1: 診断・保存 ---------------- */

let currentDiagnosis = null;   // {hits, html, text}
let currentAI = null;          // string

function runLocalDiagnosis() {
  const text = $("#dream-text").value.trim();
  const box = $("#diagnosis-result");
  if (!text) {
    setStatus($("#diag-status"), "夢の内容を入力してください。", "error");
    return null;
  }
  setStatus($("#diag-status"), "");
  const hits = matchSymbols(text);
  currentDiagnosis = { hits, html: localDiagnosisHTML(hits), text: localDiagnosisText(hits) };
  box.innerHTML = currentDiagnosis.html;
  box.hidden = false;
  return currentDiagnosis;
}

$("#btn-diagnose").addEventListener("click", runLocalDiagnosis);

$("#btn-ai-diagnose").addEventListener("click", async () => {
  const text = $("#dream-text").value.trim();
  const status = $("#diag-status");
  if (!text) { setStatus(status, "夢の内容を入力してください。", "error"); return; }

  const diag = currentDiagnosis && currentDiagnosis.hits ? currentDiagnosis : runLocalDiagnosis();
  const btn = $("#btn-ai-diagnose");
  btn.disabled = true;
  setStatus(status, "✨ AIが夢を読み解いています…（数十秒かかることがあります）");
  try {
    const result = await aiDiagnose(text, diag ? diag.hits : []);
    currentAI = result;
    const box = $("#ai-result");
    box.innerHTML = `<h3>✨ AI夢判断（${esc(settings.model)}）</h3><div class="ai-text">${esc(result)}</div>`;
    box.hidden = false;
    setStatus(status, "AI夢判断が完了しました。", "ok");
  } catch (e) {
    setStatus(status, e.message, "error");
  } finally {
    btn.disabled = false;
  }
});

$("#btn-save").addEventListener("click", () => {
  const text = $("#dream-text").value.trim();
  const date = $("#dream-date").value || todayStr();
  const status = $("#save-status");
  if (!text) { setStatus(status, "夢の内容を入力してください。", "error"); return; }

  const diag = currentDiagnosis || { hits: matchSymbols(text), text: "" };
  if (!diag.text) diag.text = localDiagnosisText(diag.hits);

  entries.push({
    id: uid(),
    date,
    text,
    diagnosis: diag.text,
    symbols: diag.hits.slice(0, 12).map((h) => h.matched),
    aiDiagnosis: currentAI || "",
    source: "手入力",
    createdAt: new Date().toISOString(),
  });
  if (saveJSON(LS_KEYS.entries, entries)) {
    setStatus(status, `💾 ${date} の夢を日記に保存しました。`, "ok");
    $("#dream-text").value = "";
    $("#diagnosis-result").hidden = true;
    $("#ai-result").hidden = true;
    currentDiagnosis = null;
    currentAI = null;
    renderDiary();
  }
});

/* ---- 手書き画像OCR（ローカルファイル） ---- */

$("#btn-ocr-image").addEventListener("click", () => $("#ocr-file-input").click());

$("#ocr-file-input").addEventListener("change", async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = "";
  if (!files.length) return;
  const status = $("#ocr-status");
  try {
    const texts = [];
    for (let i = 0; i < files.length; i++) {
      const label = `画像 ${i + 1}/${files.length}`;
      texts.push(await ocrImage(files[i], status, label));
    }
    const combined = texts.join("\n\n");
    const ta = $("#dream-text");
    ta.value = (ta.value ? ta.value + "\n\n" : "") + combined;
    const d = extractDateFromText(combined);
    if (d) $("#dream-date").value = d;
    setStatus(status, `✅ OCRが完了しました。内容を確認・修正してから診断してください。${d ? `（日付 ${d} を自動設定）` : ""}`, "ok");
  } catch (e) {
    setStatus(status, "OCRエラー: " + e.message, "error");
  }
});

/* ---------------- タブ2: 日記一覧 ---------------- */

function renderDiary() {
  const q = $("#diary-search").value.trim();
  const list = $("#diary-list");
  const sorted = [...entries].sort((a, b) => (b.date + (b.createdAt || "")).localeCompare(a.date + (a.createdAt || "")));
  const filtered = q
    ? sorted.filter((e) => (e.text + " " + (e.diagnosis || "") + " " + (e.aiDiagnosis || "") + " " + e.date).includes(q))
    : sorted;

  $("#diary-count").textContent = `全 ${entries.length} 件${q ? `（検索結果 ${filtered.length} 件）` : ""}`;

  if (filtered.length === 0) {
    list.innerHTML = `<p class="note">${q ? "検索に一致する日記がありません。" : "まだ日記がありません。「✍️ 夢を記録・診断」タブから夢を記録しましょう。"}</p>`;
    return;
  }

  list.innerHTML = filtered.map((e) => `
    <details class="diary-entry" data-id="${e.id}">
      <summary>
        <span class="entry-date">${esc(e.date)}</span>
        <span class="entry-preview">${esc(e.text.slice(0, 60))}</span>
        ${e.source && e.source !== "手入力" ? `<span class="entry-tag">${esc(e.source)}</span>` : ""}
        ${e.aiDiagnosis ? `<span class="entry-tag">✨AI診断済</span>` : ""}
      </summary>
      <div class="entry-body">
        <h4>🛌 夢の内容</h4>
        <div class="dream-text">${esc(e.text)}</div>
        ${e.diagnosis ? `<h4>🔮 辞書照合</h4><div class="diag-text">${esc(e.diagnosis)}</div>` : ""}
        ${e.aiDiagnosis ? `<h4>✨ AI夢判断</h4><div class="diag-text">${esc(e.aiDiagnosis)}</div>` : ""}
        <div class="entry-actions">
          <button class="edit" data-id="${e.id}">✏️ 編集</button>
          <button class="redo" data-id="${e.id}">🔮 再診断</button>
          <button class="del" data-id="${e.id}">🗑️ 削除</button>
        </div>
      </div>
    </details>`).join("");
}

$("#diary-search").addEventListener("input", renderDiary);

$("#diary-list").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button");
  if (!btn) return;
  const id = btn.dataset.id;
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;

  if (btn.classList.contains("del")) {
    if (confirm(`${entry.date} の日記を削除しますか？`)) {
      entries = entries.filter((e) => e.id !== id);
      saveJSON(LS_KEYS.entries, entries);
      renderDiary();
    }
  } else if (btn.classList.contains("edit")) {
    // 編集タブへ内容を読み込み
    $("#dream-date").value = entry.date;
    $("#dream-text").value = entry.text;
    currentDiagnosis = null;
    currentAI = entry.aiDiagnosis || null;
    entries = entries.filter((e) => e.id !== id);
    saveJSON(LS_KEYS.entries, entries);
    renderDiary();
    document.querySelector('[data-tab="tab-new"]').click();
    setStatus($("#save-status"), "日記を編集モードで読み込みました。修正後、再度保存してください。");
  } else if (btn.classList.contains("redo")) {
    const hits = matchSymbols(entry.text);
    entry.diagnosis = localDiagnosisText(hits);
    entry.symbols = hits.slice(0, 12).map((h) => h.matched);
    saveJSON(LS_KEYS.entries, entries);
    renderDiary();
  }
});

/* ---- エクスポート / インポート ---- */

$("#btn-export").addEventListener("click", () => {
  const payload = {
    app: "yumemiroku",
    version: 1,
    exportedAt: new Date().toISOString(),
    entries,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `夢日記_${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#btn-import").addEventListener("click", () => $("#import-file-input").click());

$("#import-file-input").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.entries;
    if (!Array.isArray(incoming)) throw new Error("夢日記のJSON形式ではありません");

    const existingIds = new Set(entries.map((e) => e.id));
    let added = 0;
    for (const e of incoming) {
      if (!e || typeof e.text !== "string" || !e.date) continue;
      if (e.id && existingIds.has(e.id)) continue; // 重複はスキップ
      entries.push({
        id: e.id || uid(),
        date: e.date,
        text: e.text,
        diagnosis: e.diagnosis || "",
        symbols: e.symbols || [],
        aiDiagnosis: e.aiDiagnosis || "",
        source: e.source || "インポート",
        createdAt: e.createdAt || new Date().toISOString(),
      });
      added++;
    }
    saveJSON(LS_KEYS.entries, entries);
    renderDiary();
    alert(`${added} 件の日記を取り込みました。（重複 ${incoming.length - added} 件はスキップ）`);
  } catch (e) {
    alert("インポートに失敗しました: " + e.message);
  }
});

/* ---------------- タブ3: 夢占い辞書・本 ---------------- */

function renderDictSearch() {
  const q = $("#dict-search").value.trim();
  const box = $("#dict-results");
  const all = allDictEntries();
  const list = q
    ? all.filter((e) => e.kw.includes(q) || (e.syn || []).some((s) => s.includes(q)) || e.meaning.includes(q))
    : all.slice(0, 30);

  if (list.length === 0) {
    box.innerHTML = `<p class="note">「${esc(q)}」に一致するシンボルはありません。</p>`;
    return;
  }
  box.innerHTML =
    (q ? "" : `<p class="note">全 ${all.length} 語収録。検索するとすべての辞書から探せます。（以下は先頭30語）</p>`) +
    list.slice(0, 100).map((e) => `
      <div class="dict-item">
        <span class="kw">${esc(e.kw)}</span>${fortuneBadge(e.fortune)}
        ${e.syn && e.syn.length ? `<span class="src">（${esc(e.syn.join("、"))}）</span>` : ""}
        <div class="meaning">${esc(e.meaning)}</div>
        <div class="src">出典: ${esc(e.source)}</div>
      </div>`).join("");
}

$("#dict-search").addEventListener("input", renderDictSearch);

/* ---- 本のアップロード ---- */

function renderBooks() {
  const box = $("#book-list");
  if (books.length === 0) {
    box.innerHTML = `<p class="note">アップロードされた本はまだありません。</p>`;
    return;
  }
  box.innerHTML = books.map((b) => `
    <div class="book-item">
      <div>
        <div class="book-name">📕 ${esc(b.name)}</div>
        <div class="book-meta">${b.dict.length} 語を収録 ・ ${new Date(b.addedAt).toLocaleDateString("ja-JP")} 登録</div>
      </div>
      <button data-id="${b.id}">削除</button>
    </div>`).join("");
}

$("#book-list").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button");
  if (!btn) return;
  const book = books.find((b) => b.id === btn.dataset.id);
  if (book && confirm(`「${book.name}」を削除しますか？`)) {
    books = books.filter((b) => b.id !== btn.dataset.id);
    saveJSON(LS_KEYS.books, books);
    renderBooks();
    renderDictSearch();
  }
});

$("#btn-upload-book").addEventListener("click", () => $("#book-file-input").click());

$("#book-file-input").addEventListener("change", async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = "";
  const status = $("#book-status");
  for (const file of files) {
    try {
      setStatus(status, `「${file.name}」を解析中…`);
      const dict = await parseBookFile(file, status);
      if (dict.length === 0) {
        setStatus(status, `「${file.name}」から夢占いデータを抽出できませんでした。「キーワード：意味」形式のテキストをお試しください。`, "error");
        continue;
      }
      books.push({ id: uid(), name: file.name, addedAt: new Date().toISOString(), dict });
      if (saveJSON(LS_KEYS.books, books)) {
        setStatus(status, `✅ 「${file.name}」から ${dict.length} 語を登録しました。`, "ok");
      } else {
        books.pop();
      }
    } catch (e) {
      setStatus(status, `「${file.name}」の解析に失敗しました: ` + e.message, "error");
    }
  }
  renderBooks();
  renderDictSearch();
});

/** 本ファイルを {kw, meaning} の辞書に変換する */
async function parseBookFile(file, statusEl) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "json") {
    const data = JSON.parse(await file.text());
    return normalizeJsonDict(data);
  }
  if (ext === "csv") {
    return parseCsvDict(await file.text());
  }
  if (ext === "pdf") {
    setStatus(statusEl, `「${file.name}」PDFからテキストを抽出中…`);
    const text = await extractPdfText(file);
    return parseTextDict(text);
  }
  // txt / md / その他テキスト
  return parseTextDict(await file.text());
}

function normalizeJsonDict(data) {
  const out = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === "object") {
        const kw = item.kw || item.keyword || item.symbol || item.word || item.名前 || item.キーワード;
        const meaning = item.meaning || item.description || item.text || item.意味 || item.解釈;
        if (kw && meaning) out.push({ kw: String(kw), syn: item.syn || item.synonyms || [], meaning: String(meaning), fortune: item.fortune || item.吉凶 || "" });
      }
    }
  } else if (data && typeof data === "object") {
    for (const [kw, meaning] of Object.entries(data)) {
      if (typeof meaning === "string") out.push({ kw, meaning });
    }
  }
  return out;
}

function parseCsvDict(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split(",");
    if (cols.length >= 2) {
      const kw = cols[0].trim().replace(/^"|"$/g, "");
      const meaning = cols.slice(1).join(",").trim().replace(/^"|"$/g, "");
      if (kw && meaning && kw !== "キーワード" && kw.toLowerCase() !== "keyword") {
        out.push({ kw, meaning });
      }
    }
  }
  return out;
}

/** テキストから「キーワード：意味」「【keyword】意味」「# 見出し + 本文」を抽出 */
function parseTextDict(text) {
  const out = [];
  const lines = text.split(/\r?\n/);

  // パターン1: 1行完結（キーワード：意味 / 【キーワード】意味 / キーワード…意味）
  const lineRe = /^\s*(?:[・\-*●○◆■]\s*)?(?:【([^】]{1,20})】|([^：:【】#=\t]{1,20})[：:])\s*(.{8,})$/;
  for (const line of lines) {
    const m = lineRe.exec(line);
    if (m) {
      const kw = (m[1] || m[2]).trim();
      const meaning = m[3].trim();
      if (kw && meaning) out.push({ kw, meaning });
    }
  }

  // パターン2: 見出し（# 蛇 / ■蛇 / 【蛇】単独行）+ 続く本文
  const headRe = /^\s*(?:#{1,4}|■|●|◆|【)\s*([^\s#■●◆【】]{1,20})\s*(?:】)?\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = headRe.exec(lines[i]);
    if (!m) continue;
    const kw = m[1].trim();
    const body = [];
    for (let j = i + 1; j < lines.length && body.join("").length < 500; j++) {
      if (headRe.test(lines[j]) || lineRe.test(lines[j])) break;
      const t = lines[j].trim();
      if (t) body.push(t);
      if (!t && body.length) break;
    }
    const meaning = body.join(" ").trim();
    if (kw && meaning.length >= 8 && !out.some((o) => o.kw === kw)) {
      out.push({ kw, meaning });
    }
  }

  // 重複除去
  const seen = new Set();
  return out.filter((o) => {
    if (seen.has(o.kw)) return false;
    seen.add(o.kw);
    return true;
  });
}

/* ---- PDF (pdf.js) ---- */

let pdfjsLoading = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  if (pdfjsLoading) return pdfjsLoading;
  pdfjsLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
      resolve();
    };
    s.onerror = () => reject(new Error("pdf.jsの読み込みに失敗しました（ネットワーク接続を確認してください）"));
    document.head.appendChild(s);
  });
  return pdfjsLoading;
}

async function extractPdfText(file) {
  await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const parts = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => it.str).join("\n"));
  }
  return parts.join("\n");
}

/* ---------------- Google Drive 連携 ---------------- */

let gisLoading = null;
function loadGIS() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Google認証ライブラリの読み込みに失敗しました"));
    document.head.appendChild(s);
  });
  return gisLoading;
}

function getDriveToken() {
  return new Promise(async (resolve, reject) => {
    try {
      await loadGIS();
      const client = google.accounts.oauth2.initTokenClient({
        client_id: settings.gdriveClientId,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        callback: (resp) => {
          if (resp.error) reject(new Error("Google認証エラー: " + resp.error));
          else resolve(resp.access_token);
        },
      });
      client.requestAccessToken();
    } catch (e) {
      reject(e);
    }
  });
}

async function driveApi(path, token) {
  const res = await fetch("https://www.googleapis.com/drive/v3/" + path, {
    headers: { Authorization: "Bearer " + token },
  });
  if (!res.ok) throw new Error(`Drive APIエラー (HTTP ${res.status})`);
  return res;
}

$("#btn-drive-import").addEventListener("click", async () => {
  const status = $("#drive-status");
  if (!settings.gdriveClientId) {
    setStatus(status, "「⚙️ 設定」タブでGoogle OAuthクライアントIDを設定してください。", "error");
    return;
  }
  const folderName = settings.gdriveFolder || "夢日記";
  const btn = $("#btn-drive-import");
  btn.disabled = true;

  try {
    setStatus(status, "Googleアカウントの認証中…（ポップアップを許可してください）");
    const token = await getDriveToken();

    // 1. フォルダを検索
    setStatus(status, `フォルダ「${folderName}」を検索中…`);
    let res = await driveApi(
      `files?q=${encodeURIComponent(`name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id,name)`,
      token);
    const folders = (await res.json()).files || [];
    if (folders.length === 0) throw new Error(`Driveにフォルダ「${folderName}」が見つかりません。`);
    const folderId = folders[0].id;

    // 2. フォルダ内の画像を一覧
    setStatus(status, "フォルダ内の画像を取得中…");
    res = await driveApi(
      `files?q=${encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed=false`)}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime&pageSize=100`,
      token);
    const images = (await res.json()).files || [];
    if (images.length === 0) throw new Error(`フォルダ「${folderName}」に画像がありません。手書き日記の写真を入れてください。`);

    // 取り込み済みの画像はスキップ
    const importedIds = new Set(entries.map((e) => e.driveFileId).filter(Boolean));
    const targets = images.filter((img) => !importedIds.has(img.id));
    if (targets.length === 0) {
      setStatus(status, `新しい画像はありません（${images.length} 件すべて取り込み済み）。`, "ok");
      return;
    }

    let ok = 0, fail = 0;
    for (let i = 0; i < targets.length; i++) {
      const img = targets[i];
      const label = `「${img.name}」(${i + 1}/${targets.length})`;
      try {
        // 3. ダウンロード
        setStatus(status, `${label} をダウンロード中…`);
        const dl = await driveApi(`files/${img.id}?alt=media`, token);
        const blob = await dl.blob();

        // 4. OCR
        const text = await ocrImage(blob, status, label);
        if (!text.trim()) throw new Error("文字を認識できませんでした");

        // 5. 診断
        setStatus(status, `${label} を夢診断中…`);
        const hits = matchSymbols(text);
        let ai = "";
        if (settings.apiKey) {
          try { ai = await aiDiagnose(text, hits); } catch (e) { console.warn("AI診断スキップ:", e); }
        }

        // 6. 日記として保存
        const date = extractDateFromText(text) ||
          (img.modifiedTime ? img.modifiedTime.slice(0, 10) : todayStr());
        entries.push({
          id: uid(),
          date,
          text: text.trim(),
          diagnosis: localDiagnosisText(hits),
          symbols: hits.slice(0, 12).map((h) => h.matched),
          aiDiagnosis: ai,
          source: "Drive OCR",
          driveFileId: img.id,
          driveFileName: img.name,
          createdAt: new Date().toISOString(),
        });
        saveJSON(LS_KEYS.entries, entries);
        renderDiary();
        ok++;
      } catch (e) {
        console.warn("取り込み失敗:", img.name, e);
        fail++;
      }
    }
    setStatus(status, `✅ 取り込み完了: ${ok} 件を日記に登録しました。${fail ? `（${fail} 件は失敗）` : ""}`, fail ? "" : "ok");
  } catch (e) {
    setStatus(status, e.message, "error");
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- タブ4: 設定 ---------------- */

function loadSettingsToForm() {
  $("#api-key").value = settings.apiKey || "";
  $("#api-model").value = settings.model || "claude-opus-4-8";
  $("#gdrive-client-id").value = settings.gdriveClientId || "";
  $("#gdrive-folder").value = settings.gdriveFolder || "夢日記";
  $("#ocr-engine").value = settings.ocrEngine || "claude";
}

$("#btn-save-settings").addEventListener("click", () => {
  settings = {
    apiKey: $("#api-key").value.trim(),
    model: $("#api-model").value,
    gdriveClientId: $("#gdrive-client-id").value.trim(),
    gdriveFolder: $("#gdrive-folder").value.trim() || "夢日記",
    ocrEngine: $("#ocr-engine").value,
  };
  saveJSON(LS_KEYS.settings, settings);
  setStatus($("#settings-status"), "✅ 設定を保存しました。", "ok");
});

$("#btn-clear-all").addEventListener("click", () => {
  if (!confirm("日記・アップロードした本・設定をすべて削除します。よろしいですか？\n（先に「日記をダウンロード」でバックアップすることをおすすめします）")) return;
  if (!confirm("本当に削除しますか？この操作は元に戻せません。")) return;
  localStorage.removeItem(LS_KEYS.entries);
  localStorage.removeItem(LS_KEYS.books);
  localStorage.removeItem(LS_KEYS.settings);
  location.reload();
});

/* ---------------- 初期化 ---------------- */

function init() {
  $("#dream-date").value = todayStr();
  loadSettingsToForm();
  setupVoice();
  renderDiary();
  renderBooks();
  renderDictSearch();
}

init();
