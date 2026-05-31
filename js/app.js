// アプリ統合: 起動フロー・保存フロー・描画・イベント
import { Store } from "./store.js";
import {
  isConfigured,
  isSignedIn,
  signIn,
  loadMaster,
  saveMaster,
} from "./drive.js";
import { loadStocks, codeToName, searchStocks } from "./stocks.js";
import { calcRealized, aggregate, calcKpis } from "./pnl.js";
import { renderCumulative, renderHistogram } from "./charts.js";

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
  renderKpis();
  renderCumulative($("cum-chart"), records);
  renderList(store.getTrades(), records);
}

// ---------- トレード成績（KPI）----------
function renderKpis() {
  const thisYear = String(new Date().getFullYear());
  const k = calcKpis(store.getTrades(), thisYear);
  const empty = k.sellCount === 0;
  $("kpi-empty").classList.toggle("hidden", !empty);

  // 表示ヘルパー
  const pct = (v) => (v === null ? "—" : (v * 100).toFixed(0) + "%");
  const x = (v) => (v === null ? "—" : v.toFixed(2) + "倍");
  const yen = (v) => (v === null ? "—" : formatYen(v));
  const days = (v) => (v === null ? "—" : v.toFixed(1) + "日");

  // 平均利益/平均損失（2値を1セルに）
  const avgWinLoss =
    k.avgWin === null && k.avgLoss === null
      ? "—"
      : `<span class="gain">${k.avgWin === null ? "—" : formatYen(k.avgWin)}</span>` +
        ` / <span class="loss">${k.avgLoss === null ? "—" : formatYen(k.avgLoss)}</span>`;

  // 平均保有期間（全体／勝ち／負け）。負≫勝なら塩漬けサイン
  const shioduke =
    k.avgHoldDaysWin !== null &&
    k.avgHoldDaysLoss !== null &&
    k.avgHoldDaysLoss > k.avgHoldDaysWin * 1.5;
  const holdSub =
    k.avgHoldDaysWin === null && k.avgHoldDaysLoss === null
      ? ""
      : `<span class="kpi-hold ${shioduke ? "warn" : ""}">勝 ${days(k.avgHoldDaysWin)} / 負 ${days(k.avgHoldDaysLoss)}${shioduke ? " ⚠塩漬け傾向" : ""}</span>`;

  // 並び順は CSS の .kpi-cell:nth-child(3) 全幅指定と対応（空セルを作らない配置）
  const cells = [
    { label: "勝率", value: pct(k.winRate), sub: `${k.winningCount}勝 ${k.losingCount}敗` },
    { label: "期待値 / 売却", value: yen(k.expectancy), cls: gainLossClass(k.expectancy || 0) },
    { label: "平均利益 / 平均損失", value: avgWinLoss, raw: true },
    { label: "損益レシオ", value: x(k.payoffRatio) },
    { label: "最大ドローダウン", value: k.maxDrawdown > 0 ? "−" + k.maxDrawdown.toLocaleString("ja-JP") : "±0", cls: k.maxDrawdown > 0 ? "loss" : "" },
    { label: "売却回数（買付）", value: `${k.sellCount}回`, sub: `買付 ${k.buyCount}回` },
    { label: "平均保有期間", value: days(k.avgHoldDays), subHtml: holdSub },
  ];

  $("kpi-grid").innerHTML = cells
    .map((c) => {
      const val = c.raw
        ? `<div class="kpi-value">${c.value}</div>`
        : `<div class="kpi-value ${c.cls || ""}">${c.value}</div>`;
      const sub = c.subHtml
        ? `<div class="kpi-sub">${c.subHtml}</div>`
        : c.sub
          ? `<div class="kpi-sub">${c.sub}</div>`
          : "";
      return `<div class="kpi-cell"><div class="kpi-label">${c.label}</div>${val}${sub}</div>`;
    })
    .join("");

  renderHistogram($("hist-chart"), k.pnls);
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
  $("f-search").value = "";
  hideSuggest();
  setSide(trade ? trade.side : "買");
  updateNamePreview();
  $("form-card").hidden = false;
  $("add-toggle").hidden = true;
  $("form-card").scrollIntoView({ behavior: "smooth", block: "center" });
}
function closeForm() {
  $("form-card").hidden = true;
  $("add-toggle").hidden = false;
  hideSuggest();
  editingId = null;
}
function setSide(side) {
  currentSide = side;
  for (const b of $("f-side").querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.side === side);
  }
  updateHoldingsPicker();
}
function updateNamePreview() {
  const code = $("f-code").value.trim();
  $("f-name").textContent = code.length === 4 ? codeToName(code) || "（名称未登録）" : "";
}

// ---------- 銘柄サジェスト ----------
function hideSuggest() {
  const list = $("suggest-list");
  list.hidden = true;
  list.innerHTML = "";
}

function renderSuggest(query) {
  const list = $("suggest-list");
  const items = searchStocks(query);
  if (items.length === 0) {
    list.hidden = true;
    list.innerHTML = "";
    return;
  }
  list.innerHTML = items
    .map(
      (it) =>
        `<li data-code="${it.code}"><span class="s-name">${it.name || "（名称未登録）"}</span>` +
        `<span class="s-code">${it.code}</span></li>`
    )
    .join("");
  list.hidden = false;
}

// サジェスト/保有ピッカーから銘柄を確定し、コード欄へ反映する。
function selectStock(code) {
  $("f-code").value = code;
  updateNamePreview();
  hideSuggest();
  $("f-search").value = "";
}

// ---------- 保有から売却 ----------
function currentHoldings() {
  const { holdings } = calcRealized(store.getTrades());
  return Object.entries(holdings)
    .filter(([, h]) => h.quantity > 0)
    .map(([code, h]) => ({ code, quantity: h.quantity, avgCost: h.cost / h.quantity }));
}

// 「売」選択時のみ保有銘柄ピッカーを表示する。
function updateHoldingsPicker() {
  const picker = $("holdings-picker");
  if (currentSide !== "売") {
    picker.hidden = true;
    return;
  }
  const holds = currentHoldings();
  const listEl = $("hp-list");
  if (holds.length === 0) {
    listEl.innerHTML = `<div class="hp-empty">保有中の銘柄がありません。</div>`;
  } else {
    listEl.innerHTML = holds
      .map((h) => {
        const name = codeToName(h.code) || "（名称未登録）";
        const avg = Math.round(h.avgCost).toLocaleString("ja-JP");
        return (
          `<button type="button" class="hp-item" data-code="${h.code}" data-qty="${h.quantity}">` +
          `<span class="hp-name">${name}<span class="hp-code">${h.code}</span></span>` +
          `<span class="hp-qty">${h.quantity.toLocaleString("ja-JP")}株 ・ 平均${avg}</span></button>`
        );
      })
      .join("");
  }
  picker.hidden = false;
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

  // 銘柄サジェスト
  $("f-search").addEventListener("input", (e) => renderSuggest(e.target.value));
  $("suggest-list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-code]");
    if (li) selectStock(li.dataset.code);
  });
  // フォーム外タップでサジェストを閉じる
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".suggest-wrap")) hideSuggest();
  });

  // 保有から売却（タップでコード・数量を流し込む）
  $("hp-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".hp-item");
    if (!btn) return;
    selectStock(btn.dataset.code);
    $("f-qty").value = btn.dataset.qty; // 既定は全株。必要なら手で減らせる
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
    $("signin-note").textContent =
      "いまはこの端末に保存したデータを表示しています。上のボタンをタップすると Google Drive の最新と同期します。";
  } else {
    $("signin-note").textContent =
      "現在はローカル保存で動作中。クラウド同期を使うには README の手順で設定してください。";
  }
  // iOS Safari/PWA では起動時のサイレント認証（ユーザー操作なしのトークン取得）が
  // 自動ポップアップ抑止＋ITPにより成立しないため行わない。サインインはボタンのタップ起点とする。
  setSync("", isConfigured() ? "ローカル表示中（タップで同期）" : "未サインイン");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW登録失敗:", e));
  }
}

init();
