// アプリ統合: 起動フロー・保存フロー・描画・イベント
import { Store } from "./store.js";
import {
  isConfigured,
  isSignedIn,
  signIn,
  loadMaster,
  saveMaster,
} from "./drive.js";
import { loadStocks, codeToName } from "./stocks.js";
import { calcRealized, aggregate } from "./pnl.js";
import { renderCumulative } from "./charts.js";

const store = new Store();
let axis = "month"; // year | month | code
let editingId = null;
let currentSide = "買";

const $ = (id) => document.getElementById(id);

// ---------- 表示ユーティリティ ----------
function formatYen(n, sign = true) {
  const s = n > 0 ? (sign ? "+" : "") : n < 0 ? "−" : "±";
  return s + Math.abs(Math.round(n)).toLocaleString("ja-JP");
}
function gainLossClass(n) {
  return n > 0 ? "gain" : n < 0 ? "loss" : "";
}

function setSync(state, text) {
  const el = $("sync");
  el.className = "sync" + (state ? " " + state : "");
  $("sync-text").textContent = text;
}

// ---------- 描画 ----------
function renderAll() {
  const { records } = calcRealized(store.getTrades());
  renderSummary(records);
  renderCumulative($("cum-chart"), records);
  renderList(store.getTrades(), records);
}

function renderSummary(records) {
  const years = aggregate(records, "year");
  const thisYear = String(new Date().getFullYear());
  const hero = years[0] || { key: thisYear, gross: 0, tax: 0, net: 0 };

  $("hero-label").textContent = `${hero.key}年 税引後損益`;
  const hv = $("hero-value");
  hv.className = "value " + gainLossClass(hero.net);
  hv.innerHTML = `${formatYen(hero.net)}<span class="yen">円</span>`;
  const hg = $("hero-gross");
  hg.className = "v " + gainLossClass(hero.gross);
  hg.textContent = formatYen(hero.gross);
  $("hero-tax").textContent = hero.tax > 0 ? "−" + hero.tax.toLocaleString("ja-JP") : "0";

  // 集計表
  const rows = aggregate(records, axis, codeToName);
  const thead = $("summary-table").querySelector("thead");
  const tbody = $("summary-table").querySelector("tbody");
  const firstCol = axis === "code" ? "銘柄" : axis === "year" ? "年" : "月";
  thead.innerHTML = `<tr><th>${firstCol}</th><th>税引前</th><th>概算税</th><th>税引後</th></tr>`;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="table-empty">売却の記録がありません</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      let label;
      if (axis === "code") label = (r.name || r.key) + ` <span style="color:#b0b0b5;font-size:11px">${r.key}</span>`;
      else if (axis === "year") label = r.key + "年";
      else label = r.key.replace("-", "/");
      return (
        `<tr><td>${label}</td>` +
        `<td class="${gainLossClass(r.gross)}">${formatYen(r.gross)}</td>` +
        `<td>${r.tax > 0 ? r.tax.toLocaleString("ja-JP") : "0"}</td>` +
        `<td class="${gainLossClass(r.net)}">${formatYen(r.net)}</td></tr>`
      );
    })
    .join("");
}

function renderList(trades, records) {
  const pnlById = {};
  for (const r of records) pnlById[r.tradeId] = r.pnl;

  const sorted = [...trades].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const list = $("trade-list");
  $("empty-note").classList.toggle("hidden", sorted.length > 0);

  list.innerHTML = sorted
    .map((t) => {
      const name = codeToName(t.code) || "（名称未登録）";
      const isSell = t.side === "売";
      const pnl = pnlById[t.id];
      const right = isSell
        ? (pnl !== undefined
            ? `<span class="pnl-tag ${gainLossClass(pnl)}">${formatYen(pnl)}</span>`
            : `<span class="pnl-tag muted">—</span>`)
        : `<span class="pnl-tag muted">買付</span>`;
      const price = Number(t.price).toLocaleString("ja-JP");
      return (
        `<div class="trade">` +
        `<div class="left"><div class="name">${name}<span class="code">${t.code}</span></div>` +
        `<div class="meta">${t.date.replace(/-/g, "/")} ・ ${t.quantity}株 @${price}</div></div>` +
        `<div class="right">${right}` +
        `<span class="badge ${isSell ? "sell" : "buy"}">${t.side}</span>` +
        `<span class="row-actions"><button data-edit="${t.id}">✏️</button>` +
        `<button data-del="${t.id}">🗑</button></span></div></div>`
      );
    })
    .join("");
}

// ---------- 保存（Drive）----------
async function saveToDrive() {
  if (!isSignedIn()) {
    setSync("", "ローカル保存（未サインイン）");
    return;
  }
  try {
    setSync("busy", "保存中…");
    await saveMaster(store.getMaster());
    setSync("ok", "保存済み");
  } catch (e) {
    console.error(e);
    setSync("error", "保存に失敗");
  }
}

async function syncFromDrive() {
  setSync("busy", "読込中…");
  try {
    const master = await loadMaster();
    if (master) {
      store.setMaster(master);
    } else {
      // Drive上に未作成 → 現在のローカル内容で新規作成
      await saveMaster(store.getMaster());
    }
    renderAll();
    setSync("ok", "保存済み");
    $("signin-bar").classList.add("hidden");
  } catch (e) {
    console.error(e);
    setSync("error", "同期に失敗");
  }
}

// ---------- フォーム ----------
function openForm(trade) {
  editingId = trade ? trade.id : null;
  $("form-title").textContent = trade ? "取引を編集" : "取引を追加";
  $("form-submit").textContent = trade ? "更新する" : "追加する";
  $("f-date").value = trade ? trade.date : new Date().toISOString().slice(0, 10);
  $("f-code").value = trade ? trade.code : "";
  $("f-qty").value = trade ? trade.quantity : "";
  $("f-price").value = trade ? trade.price : "";
  setSide(trade ? trade.side : "買");
  updateNamePreview();
  $("form-card").hidden = false;
  $("add-toggle").hidden = true;
  $("form-card").scrollIntoView({ behavior: "smooth", block: "center" });
}
function closeForm() {
  $("form-card").hidden = true;
  $("add-toggle").hidden = false;
  editingId = null;
}
function setSide(side) {
  currentSide = side;
  for (const b of $("f-side").querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.side === side);
  }
}
function updateNamePreview() {
  const code = $("f-code").value.trim();
  $("f-name").textContent = code.length === 4 ? codeToName(code) || "（名称未登録）" : "";
}

function onSubmit(ev) {
  ev.preventDefault();
  const date = $("f-date").value;
  const code = $("f-code").value.trim();
  const quantity = Number($("f-qty").value);
  const price = Number($("f-price").value);
  if (!date || !/^\d{4}$/.test(code) || !(quantity > 0) || !(price >= 0)) {
    alert("入力内容を確認してください（銘柄コードは4桁、数量は1以上）。");
    return;
  }
  const trade = { date, code, side: currentSide, quantity, price };
  if (editingId) store.updateTrade(editingId, trade);
  else store.addTrade(trade);
  closeForm();
  renderAll();
  saveToDrive();
}

// ---------- イベント結線 ----------
function wireEvents() {
  $("seg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-axis]");
    if (!btn) return;
    axis = btn.dataset.axis;
    for (const b of $("seg").querySelectorAll("button")) b.classList.toggle("active", b === btn);
    renderAll();
  });

  $("add-toggle").addEventListener("click", () => openForm(null));
  $("form-cancel").addEventListener("click", closeForm);
  $("trade-form").addEventListener("submit", onSubmit);
  $("f-code").addEventListener("input", updateNamePreview);
  $("f-side").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-side]");
    if (b) setSide(b.dataset.side);
  });

  $("trade-list").addEventListener("click", (e) => {
    const editId = e.target.closest("button[data-edit]")?.dataset.edit;
    const delId = e.target.closest("button[data-del]")?.dataset.del;
    if (editId) {
      const t = store.getTrades().find((x) => x.id === editId);
      if (t) openForm(t);
    } else if (delId) {
      if (confirm("この取引を削除しますか？")) {
        store.deleteTrade(delId);
        renderAll();
        saveToDrive();
      }
    }
  });

  $("signin-btn").addEventListener("click", async () => {
    if (!isConfigured()) {
      $("signin-note").textContent =
        "未設定です。README の手順で js/config.js に Google OAuth クライアントID を設定してください（それまではローカル保存で動作します）。";
      return;
    }
    try {
      setSync("busy", "サインイン中…");
      await signIn();
      await syncFromDrive();
    } catch (e) {
      console.error(e);
      setSync("error", "サインインに失敗");
    }
  });
}

// ---------- 起動 ----------
async function init() {
  await loadStocks();
  store.loadCache(); // 直近のキャッシュを表示（オフライン/未サインインでも閲覧可）
  wireEvents();
  renderAll();
  if (isConfigured()) {
    $("signin-note").textContent = "サインインすると Google Drive のマスターと同期します。";
  } else {
    $("signin-note").textContent =
      "現在はローカル保存で動作中。クラウド同期を使うには README の手順で設定してください。";
  }
  setSync("", "未サインイン");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW登録失敗:", e));
  }
}

init();
