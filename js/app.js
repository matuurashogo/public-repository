// アプリ統合: 起動フロー・保存フロー・描画・イベント
import { Store, mergeMasters } from "./store.js";
import {
  isConfigured,
  isSignedIn,
  signIn,
  loadMaster,
  saveMaster,
} from "./drive.js";
import { loadStocks, codeToName, searchStocks } from "./stocks.js";
import { calcRealized, aggregate, calcKpis, withMatsuiFees } from "./pnl.js";
import { MATSUI_BOX_RATE } from "./config.js";
import { renderCumulative, renderHistogram } from "./charts.js";

const store = new Store();
let axis = "month"; // year | month | code
let editingId = null;
let currentSide = "買";
let currentAccount = "特定"; // 特定 | NISA

const $ = (id) => document.getElementById(id);

// 計算・表示に使う取引（松井ボックスレートの手数料を自動付与したもの）。
// 1日の約定代金合計から算出するため、必ずこの単一経路を通す。
function tradesForCalc() {
  return withMatsuiFees(store.getTrades(), MATSUI_BOX_RATE);
}

// ---------- 表示ユーティリティ ----------
function formatYen(n, sign = true) {
  const s = n > 0 ? (sign ? "+" : "") : n < 0 ? "−" : "±";
  return s + Math.abs(Math.round(n)).toLocaleString("ja-JP");
}
function gainLossClass(n) {
  return n > 0 ? "gain" : n < 0 ? "loss" : "";
}
// innerHTML へ差し込む前にユーザー由来テキストをエスケープする（将来のメモ欄等に備える）
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function setSync(state, text) {
  const el = $("sync");
  el.className = "sync" + (state ? " " + state : "");
  $("sync-text").textContent = text;
}

// ---------- 描画 ----------
function renderAll() {
  const trades = tradesForCalc();
  const { records, warnings, holdings } = calcRealized(trades);
  renderWarnings(warnings);
  renderSummary(records);
  renderHoldings(holdings);
  renderKpis();
  renderCumulative($("cum-chart"), records);
  renderList(trades, records);
}

// 保有銘柄カード: 銘柄 / 保有数 / 平均取得単価（取得総額の大きい順）。
// holdings は calcRealized が返す { code: { quantity, cost } }。
function renderHoldings(holdings) {
  const rows = Object.entries(holdings)
    .filter(([, h]) => h.quantity > 0)
    .map(([code, h]) => ({ code, quantity: h.quantity, cost: h.cost, avg: h.cost / h.quantity }))
    .sort((a, b) => b.cost - a.cost); // 取得総額の大きい順

  const thead = $("holdings-table").querySelector("thead");
  const tbody = $("holdings-table").querySelector("tbody");
  thead.innerHTML = `<tr><th>銘柄</th><th>保有数</th><th>平均取得単価</th></tr>`;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="table-empty">保有中の銘柄はありません</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const name = esc(codeToName(r.code) || "（名称未登録）");
      const avg = Math.round(r.avg).toLocaleString("ja-JP");
      return (
        `<tr><td>${name} <span style="color:#b0b0b5;font-size:11px">${esc(r.code)}</span></td>` +
        `<td>${r.quantity.toLocaleString("ja-JP")}株</td>` +
        `<td>${avg}</td></tr>`
      );
    })
    .join("");
}

// calcRealized の警告（保有超過売却など）をバナー表示する
function renderWarnings(warnings) {
  const el = $("warn-banner");
  if (!warnings || warnings.length === 0) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.innerHTML =
    `<div class="warn-title">⚠ 入力の確認（${warnings.length}件）</div>` +
    warnings.map((w) => `<div class="warn-item">${esc(w)}</div>`).join("");
  el.classList.remove("hidden");
}

// ---------- トレード成績（KPI）----------
function renderKpis() {
  const thisYear = String(new Date().getFullYear());
  const k = calcKpis(tradesForCalc(), thisYear);
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
  // 申告分離課税は年単位・全銘柄通算後のネットにかかるため、税額は「年」軸でのみ表示する。
  // 月別・銘柄別は誤解を避けて税引前のみ表示する。
  const isYear = axis === "year";
  const rows = aggregate(records, axis, codeToName);
  const thead = $("summary-table").querySelector("thead");
  const tbody = $("summary-table").querySelector("tbody");
  const note = $("summary-note");
  const firstCol = axis === "code" ? "銘柄" : axis === "year" ? "年" : "月";

  thead.innerHTML = isYear
    ? `<tr><th>${firstCol}</th><th>税引前</th><th>概算税</th><th>税引後</th></tr>`
    : `<tr><th>${firstCol}</th><th>税引前</th></tr>`;

  note.textContent = isYear
    ? "概算税は特定口座の年間ネットに対する20.315%（NISA除外・損失の繰越控除は未考慮）。"
    : "税額は年単位・全銘柄の損益通算後にかかるため、月別・銘柄別は税引前のみ表示しています。";

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${isYear ? 4 : 2}" class="table-empty">売却の記録がありません</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      let label;
      if (axis === "code") label = `${esc(r.name || r.key)} <span style="color:#b0b0b5;font-size:11px">${esc(r.key)}</span>`;
      else if (axis === "year") label = esc(r.key) + "年";
      else label = esc(r.key.replace("-", "/"));
      if (!isYear) {
        return (
          `<tr><td>${label}</td>` +
          `<td class="${gainLossClass(r.gross)}">${formatYen(r.gross)}</td></tr>`
        );
      }
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
      const name = esc(codeToName(t.code) || "（名称未登録）");
      const isSell = t.side === "売";
      const pnl = pnlById[t.id];
      const right = isSell
        ? (pnl !== undefined
            ? `<span class="pnl-tag ${gainLossClass(pnl)}">${formatYen(pnl)}</span>`
            : `<span class="pnl-tag muted">—</span>`)
        : `<span class="pnl-tag muted">買付</span>`;
      const price = Number(t.price).toLocaleString("ja-JP");
      const nisa = t.account === "NISA" ? `<span class="acct-tag">NISA</span>` : "";
      const fee = Number(t.fee) > 0 ? ` ・ 手数料${Number(t.fee).toLocaleString("ja-JP")}` : "";
      const label = `${name} ${t.code}`;
      return (
        `<div class="trade">` +
        `<div class="left"><div class="name">${name}<span class="code">${esc(t.code)}</span>${nisa}</div>` +
        `<div class="meta">${esc(t.date.replace(/-/g, "/"))} ・ ${esc(t.quantity)}株 @${price}${fee}</div></div>` +
        `<div class="right">${right}` +
        `<span class="badge ${isSell ? "sell" : "buy"}">${t.side}</span>` +
        `<span class="row-actions">` +
        `<button data-edit="${t.id}" aria-label="${esc(label)} を編集">✏️</button>` +
        `<button data-del="${t.id}" aria-label="${esc(label)} を削除">🗑</button>` +
        `</span></div></div>`
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
    if (e && e.code === "CONFLICT") {
      // 別端末が先に保存していた → 取得してマージし、再保存する（消失を防ぐ）
      try {
        setSync("busy", "他端末の変更とマージ中…");
        const remote = await loadMaster();
        const merged = mergeMasters(store.getMaster(), remote);
        store.setMaster(merged);
        await saveMaster(merged);
        renderAll();
        setSync("ok", "マージして保存");
        return;
      } catch (e2) {
        console.error(e2);
        setSync("error", "マージに失敗");
        return;
      }
    }
    console.error(e);
    setSync("error", "保存に失敗");
  }
}

async function syncFromDrive() {
  setSync("busy", "読込中…");
  try {
    const remote = await loadMaster();
    if (remote) {
      // ローカル（未サインイン中の追加・編集・削除を含む）とマージしてから採用・保存
      const merged = mergeMasters(store.getMaster(), remote);
      store.setMaster(merged);
      await saveMaster(merged);
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
// ローカル日付(YYYY-MM-DD)。toISOString はUTC基準でJST早朝に前日へずれるため使わない。
function todayLocalISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function openForm(trade) {
  editingId = trade ? trade.id : null;
  $("form-title").textContent = trade ? "取引を編集" : "取引を追加";
  $("form-submit").textContent = trade ? "更新する" : "追加する";
  $("f-date").value = trade ? trade.date : todayLocalISO();
  $("f-code").value = trade ? trade.code : "";
  $("f-qty").value = trade ? trade.quantity : "";
  $("f-price").value = trade ? trade.price : "";
  $("f-search").value = "";
  hideSuggest();
  setSide(trade ? trade.side : "買");
  setAccount(trade ? trade.account || "特定" : "特定");
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
    const on = b.dataset.side === side;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
  updateHoldingsPicker();
}
function setAccount(acct) {
  currentAccount = acct;
  for (const b of $("f-account").querySelectorAll("button")) {
    const on = b.dataset.acct === acct;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
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
        `<li data-code="${it.code}"><span class="s-name">${esc(it.name || "（名称未登録）")}</span>` +
        `<span class="s-code">${esc(it.code)}</span></li>`
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
  const { holdings } = calcRealized(tradesForCalc());
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
        const name = esc(codeToName(h.code) || "（名称未登録）");
        const avg = Math.round(h.avgCost).toLocaleString("ja-JP");
        return (
          `<button type="button" class="hp-item" data-code="${h.code}" data-qty="${h.quantity}">` +
          `<span class="hp-name">${name}<span class="hp-code">${esc(h.code)}</span></span>` +
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
  // 手数料は松井ボックスレートで自動算出するため、ここでは保持しない
  const trade = { date, code, side: currentSide, quantity, price, account: currentAccount };
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
    for (const b of $("seg").querySelectorAll("button")) {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-pressed", b === btn ? "true" : "false");
    }
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
  $("f-account").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-acct]");
    if (b) setAccount(b.dataset.acct);
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
