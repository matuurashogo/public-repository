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
import { loadPrices, getPriceMap, getPriceDate } from "./prices.js";
import { calcRealized, aggregate, calcKpis, withMatsuiFees, calcUnrealized, tagBreakdown, entryTagAttribution, summarize } from "./pnl.js";
import { prefetchIndicators, getSnapshot, bucketOf, indicatorStatus } from "./indicators.js";
import { MATSUI_BOX_RATE } from "./config.js";
import { renderCumulative, renderHistogram } from "./charts.js";

const store = new Store();
let axis = "month"; // year | month | code
let editingId = null;
let currentSide = "買";
let currentAccount = "特定"; // 特定 | NISA
let currentEntryTag = null; // フォームで選択中のエントリー根拠タグ
let currentExitTag = null; // フォームで選択中の手仕舞い根拠タグ
let manageEntry = false; // エントリータグの管理モード（改名・削除）
let manageExit = false; // 手仕舞いタグの管理モード
let tagAxis = "entry"; // 型別成績の軸: entry | exit

const $ = (id) => document.getElementById(id);

// 計算・表示に使う取引（松井ボックスレートの手数料を自動付与したもの）。
// 1日の約定代金合計から算出するため、必ずこの単一経路を通す。
function tradesForCalc() {
  return withMatsuiFees(store.getTrades(), MATSUI_BOX_RATE);
}

// 買い銘柄の客観スナップショットを必要分だけ先読みし、完了後に再描画する。
async function refreshIndicators() {
  const codes = store.getTrades().filter((t) => t.side === "買").map((t) => t.code);
  await prefetchIndicators(codes);
  renderTagBreakdown();
  renderMissingIndicators();
  renderList(tradesForCalc(), calcRealized(tradesForCalc()).records);
}

// 取引したが客観データ未取得（監視リスト外など）の銘柄を一覧表示し、追加を案内する。
// 取得が確定した銘柄のみ判定するため、先読み完了前は何も出さない（誤検出を防ぐ）。
function renderMissingIndicators() {
  const seen = new Set();
  const missing = [];
  for (const t of store.getTrades()) {
    if (t.side !== "買") continue;
    const code = String(t.code);
    if (seen.has(code)) continue;
    seen.add(code);
    if (indicatorStatus(code) === "missing") {
      missing.push({ code, name: codeToName(code) || "（名称未登録）" });
    }
  }

  const card = $("missing-card");
  if (missing.length === 0) {
    card.hidden = true;
    return;
  }
  missing.sort((a, b) => (a.code < b.code ? -1 : 1));
  $("missing-note").textContent =
    `${missing.length}銘柄は客観スナップショットがありません。下のコードを data/indicators_universe.json の codes に追加すると、次回のデータ更新から表示されます。`;
  $("missing-list").innerHTML = missing
    .map((m) => `<span class="missing-chip">${esc(m.name)}<span class="missing-code">${esc(m.code)}</span></span>`)
    .join("");
  // 監視リストへ貼り付けやすい形（"7011", "9501"）でコピーできるよう data 属性に持たせる
  $("missing-copy").dataset.codes = missing.map((m) => `"${m.code}"`).join(", ");
}

// ---------- 表示ユーティリティ ----------
function formatYen(n, sign = true) {
  const s = n > 0 ? (sign ? "+" : "") : n < 0 ? "−" : "±";
  return s + Math.abs(Math.round(n)).toLocaleString("ja-JP");
}
function gainLossClass(n) {
  return n > 0 ? "gain" : n < 0 ? "loss" : "";
}
// 含み損益率を符号付き％で表示（+12.3% / −4.5%）
function formatPct(rate) {
  const v = rate * 100;
  const s = v > 0 ? "+" : v < 0 ? "−" : "±";
  return s + Math.abs(v).toFixed(1) + "%";
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
  renderTagBreakdown();
  renderMissingIndicators();
  renderCumulative($("cum-chart"), records);
  renderList(trades, records);
}

// 軸ごとの 見出し列名 / 補足注記
const AXIS_LABEL = {
  entry: "入口タグ",
  exit: "出口タグ",
  dip: "凹みの深さ",
  vol: "出来高",
  trend: "トレンド位置",
  rsi: "RSI",
  hv: "ボラティリティ",
};
const AXIS_NOTE = {
  entry: "入口タグ別。売却損益をFIFOで買いロットへ遡って集計（1対1は厳密、分割は株数按分）。",
  exit: "出口タグ別。各売却の実現損益をそのまま集計。",
  dip: "客観：買い日付時点の25日線乖離（凹みの深さ）別。",
  vol: "客観：買い日付時点の出来高（20日平均比）別。",
  trend: "客観：買い日付時点の75日線に対する位置別。",
  rsi: "客観：買い日付時点のRSI(14)（売られすぎ度）別。",
  hv: "客観：買い日付時点の年率ヒストリカル・ボラティリティ別。",
};

// 客観軸（dip/vol/trend）の集計。買いロットのスナップショットでバケット分けし、欠損は除外。
// 戻り値: { rows, noData }
function objectiveBreakdown(axis) {
  const units = [];
  let noData = 0;
  for (const a of entryTagAttribution(tradesForCalc())) {
    const snap = getSnapshot(a.code, a.entryDate);
    const key = bucketOf(axis, snap);
    if (!key) {
      noData += 1;
      continue;
    }
    units.push({ key, pnl: a.pnlShare });
  }
  return { rows: summarize(units), noData };
}

// ---------- エントリー型別成績 ----------
function renderTagBreakdown() {
  const isTag = tagAxis === "entry" || tagAxis === "exit";
  let rows;
  let noData = 0;
  if (isTag) {
    rows = tagBreakdown(tradesForCalc(), tagAxis);
  } else {
    const res = objectiveBreakdown(tagAxis);
    rows = res.rows;
    noData = res.noData;
  }
  rows = rows.filter((r) => r.count > 0);

  const thead = $("tag-breakdown-table").querySelector("thead");
  const tbody = $("tag-breakdown-table").querySelector("tbody");
  const note = $("tag-breakdown-note");

  thead.innerHTML =
    `<tr><th>${AXIS_LABEL[tagAxis]}</th><th>回数</th><th>勝率</th><th>平均利益/損失</th><th>合計</th></tr>`;

  if (rows.length === 0) {
    const msg = isTag
      ? "売却の記録がまだありません"
      : "客観データのある売却がまだありません（監視リストに銘柄を追加すると表示）";
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty">${msg}</td></tr>`;
    note.textContent = "";
    return;
  }

  const pct = (v) => (v === null ? "—" : (v * 100).toFixed(0) + "%");
  tbody.innerHTML = rows
    .map((r) => {
      const avgWin = r.avgWin === null ? "—" : formatYen(r.avgWin);
      const avgLoss = r.avgLoss === null ? "—" : formatYen(r.avgLoss);
      return (
        `<tr><td>${esc(r.tag)}</td>` +
        `<td>${r.count}回<div class="bd-sub">${r.winningCount}勝${r.losingCount}敗</div></td>` +
        `<td>${pct(r.winRate)}</td>` +
        `<td><span class="gain">${avgWin}</span> / <span class="loss">${avgLoss}</span></td>` +
        `<td class="${gainLossClass(r.totalPnl)}">${formatYen(r.totalPnl)}</td></tr>`
      );
    })
    .join("");

  const noDataNote = noData > 0 ? ` ／ スナップショット無し ${noData}件は除外（監視リスト未登録など）。` : "";
  note.textContent = AXIS_NOTE[tagAxis] + noDataNote;
}

// ---------- タグchip（入力フォーム）----------
function renderTagChips() {
  const m = store.getMaster();
  $("entry-tags").innerHTML = chipsHtml(m.entryTags, currentEntryTag, "entry");
  $("exit-tags").innerHTML = chipsHtml(m.exitTags, currentExitTag, "exit");
}
function chipsHtml(tags, selected, kind) {
  const manage = kind === "entry" ? manageEntry : manageExit;
  const chips = (tags || []).map((t) => {
    if (manage) {
      return (
        `<span class="tag-chip manage">${esc(t)}` +
        `<button type="button" class="tag-mini" data-rename="${esc(t)}" data-kind="${kind}" aria-label="${esc(t)} を改名">✎</button>` +
        `<button type="button" class="tag-mini del" data-delete="${esc(t)}" data-kind="${kind}" aria-label="${esc(t)} を削除">×</button>` +
        `</span>`
      );
    }
    const on = t === selected;
    return (
      `<button type="button" class="tag-chip${on ? " active" : ""}" ` +
      `data-tag="${esc(t)}" data-kind="${kind}" aria-pressed="${on ? "true" : "false"}">${esc(t)}</button>`
    );
  });
  if (manage) {
    chips.push(`<button type="button" class="tag-chip done" data-managedone="${kind}">完了</button>`);
  } else {
    chips.push(`<button type="button" class="tag-chip add" data-add="${kind}">＋新規</button>`);
    chips.push(`<button type="button" class="tag-chip manage-toggle" data-manage="${kind}">管理</button>`);
  }
  return chips.join("");
}

// chip のタップ: ＋新規/管理/完了/改名/削除/選択トグルを振り分ける
function onTagChipClick(e) {
  const addBtn = e.target.closest("button[data-add]");
  if (addBtn) return addTagPrompt(addBtn.dataset.add);

  const manageBtn = e.target.closest("button[data-manage]");
  if (manageBtn) return setManage(manageBtn.dataset.manage, true);

  const doneBtn = e.target.closest("button[data-managedone]");
  if (doneBtn) return setManage(doneBtn.dataset.managedone, false);

  const renBtn = e.target.closest("button[data-rename]");
  if (renBtn) return renameTagPrompt(renBtn.dataset.kind, renBtn.dataset.rename);

  const delBtn = e.target.closest("button[data-delete]");
  if (delBtn) return deleteTagConfirm(delBtn.dataset.kind, delBtn.dataset.delete);

  const chip = e.target.closest("button[data-tag]");
  if (!chip) return;
  const tag = chip.dataset.tag;
  if (chip.dataset.kind === "entry") {
    currentEntryTag = currentEntryTag === tag ? null : tag;
  } else {
    currentExitTag = currentExitTag === tag ? null : tag;
  }
  renderTagChips();
}

// 管理モードの開始/終了
function setManage(kind, on) {
  if (kind === "entry") manageEntry = on;
  else manageExit = on;
  renderTagChips();
}

// タグの改名（候補リストと既存取引・選択中タグを追従）
function renameTagPrompt(kind, oldName) {
  const next = window.prompt("タグの新しい名前", oldName);
  if (next == null) return;
  const to = next.trim();
  if (!to || to === oldName) return;
  if (!store.renameTag(kind, oldName, to)) return;
  if (kind === "entry" && currentEntryTag === oldName) currentEntryTag = to;
  if (kind === "exit" && currentExitTag === oldName) currentExitTag = to;
  renderTagChips();
  renderAll(); // 取引履歴・型別成績のタグ表示を更新
  saveToDrive();
}

// タグの削除（候補から外すのみ。過去取引の記録は残す）
function deleteTagConfirm(kind, name) {
  if (!window.confirm(`タグ「${name}」を候補から削除しますか？\n（過去の取引に付いた記録はそのまま残ります）`)) return;
  if (!store.deleteTag(kind, name)) return;
  if (kind === "entry" && currentEntryTag === name) currentEntryTag = null;
  if (kind === "exit" && currentExitTag === name) currentExitTag = null;
  renderTagChips();
  saveToDrive();
}

// 新規タグを追加（iOS Safari でも使える prompt）。追加後はそのタグを選択状態にする。
function addTagPrompt(kind) {
  const name = (window.prompt(kind === "entry" ? "新しいエントリー根拠タグ" : "新しい手仕舞い根拠タグ") || "").trim();
  if (!name) return;
  const added = kind === "entry" ? store.addEntryTag(name) : store.addExitTag(name);
  if (kind === "entry") currentEntryTag = name;
  else currentExitTag = name;
  renderTagChips();
  if (added) saveToDrive();
}

// 保有銘柄カード: 銘柄 / 保有数 / 平均取得単価 / 現在値 / 評価額 / 含み損益（評価額の大きい順）。
// holdings は calcRealized が返す { code: { quantity, cost } }。
// 最新終値（latest_prices.json）があれば含み損益（未実現）を併記し、合計と基準日も表示する。
function renderHoldings(holdings) {
  const { rows, total } = calcUnrealized(holdings, getPriceMap());

  const thead = $("holdings-table").querySelector("thead");
  const tbody = $("holdings-table").querySelector("tbody");
  const note = $("holdings-note");
  const date = getPriceDate();

  // 基準日の注記（価格未取得なら従来の3列にフォールバック）
  const hasPrices = date && rows.some((r) => r.priced);
  thead.innerHTML = hasPrices
    ? `<tr><th>銘柄</th><th>保有数</th><th>平均取得単価</th><th>現在値</th><th>評価額</th><th>含み損益</th></tr>`
    : `<tr><th>銘柄</th><th>保有数</th><th>平均取得単価</th></tr>`;

  if (rows.length === 0) {
    const cols = hasPrices ? 6 : 3;
    tbody.innerHTML = `<tr><td colspan="${cols}" class="table-empty">保有中の銘柄はありません</td></tr>`;
    if (note) note.textContent = "";
    return;
  }

  const yen = (n) => Math.round(n).toLocaleString("ja-JP");
  tbody.innerHTML = rows
    .map((r) => {
      const name = esc(codeToName(r.code) || "（名称未登録）");
      const codeTag = `<span style="color:#b0b0b5;font-size:11px">${esc(r.code)}</span>`;
      const avg = yen(r.avg);
      const qty = `${r.quantity.toLocaleString("ja-JP")}株`;
      if (!hasPrices) {
        return `<tr><td>${name} ${codeTag}</td><td>${qty}</td><td>${avg}</td></tr>`;
      }
      if (!r.priced) {
        // 価格欠損銘柄は現在値以降を「—」
        return (
          `<tr><td>${name} ${codeTag}</td><td>${qty}</td><td>${avg}</td>` +
          `<td class="muted">—</td><td class="muted">—</td><td class="muted">—</td></tr>`
        );
      }
      const rate =
        r.unrealizedRate === null ? "" : ` <span class="rate">(${formatPct(r.unrealizedRate)})</span>`;
      return (
        `<tr><td>${name} ${codeTag}</td><td>${qty}</td><td>${avg}</td>` +
        `<td>${yen(r.price)}</td><td>${yen(r.marketValue)}</td>` +
        `<td class="${gainLossClass(r.unrealized)}">${formatYen(r.unrealized)}${rate}</td></tr>`
      );
    })
    .join("");

  // 合計行＋基準日の注記（最小限：基準日・含み損益のみ。欠損時のみ注記を足す）
  if (note) {
    if (!hasPrices) {
      note.textContent = "最新株価が取得できませんでした（含み損益は非表示）。";
    } else {
      const totalRate =
        total.unrealizedRate === null ? "" : `（${formatPct(total.unrealizedRate)}）`;
      const cls = gainLossClass(total.unrealized);
      const excluded = total.pricedAll
        ? ""
        : ` ／ ${total.unpricedCount}銘柄は株価未取得`;
      const shortDate = esc(date).replace(/^\d{4}-/, "").replace("-", "/"); // 2026-06-01 → 06/01
      note.innerHTML =
        `${shortDate}終値 ／ 含み損益 <span class="${cls}">${formatYen(total.unrealized)}</span>円${totalRate}${esc(excluded)}`;
    }
  }
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
      const rtag = isSell ? t.exitTag : t.entryTag;
      const tagBadge = rtag ? `<div class="trade-tag">${esc(rtag)}</div>` : "";
      // 買いは、その日の客観スナップショット（取得済みなら）を併記
      const snap = !isSell ? getSnapshot(t.code, t.date) : null;
      const snapLine = snap
        ? `<div class="trade-snap">データ: ${formatPct(snap.dev)}・${snap.abv ? "75日線上" : "75日線下"}・出来高${snap.vol.toFixed(1)}倍</div>`
        : "";
      return (
        `<div class="trade">` +
        `<div class="left"><div class="name">${name}<span class="code">${esc(t.code)}</span>${nisa}</div>` +
        `<div class="meta">${esc(t.date.replace(/-/g, "/"))} ・ ${esc(t.quantity)}株 @${price}${fee}</div>${tagBadge}${snapLine}</div>` +
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
    refreshIndicators();
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
  currentEntryTag = trade ? trade.entryTag ?? null : null;
  currentExitTag = trade ? trade.exitTag ?? null : null;
  manageEntry = false;
  manageExit = false;
  $("f-entry-note").value = trade && trade.entryNote ? trade.entryNote : "";
  $("f-exit-note").value = trade && trade.exitNote ? trade.exitNote : "";
  setSide(trade ? trade.side : "買");
  setAccount(trade ? trade.account || "特定" : "特定");
  renderTagChips();
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
  // 根拠ブロックを売買で出し分ける（買い=エントリー / 売り=手仕舞い）
  $("entry-rationale").hidden = side !== "買";
  $("exit-rationale").hidden = side !== "売";
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
  // 売買に応じて根拠を載せ、反対側のフィールドは null で揃える（編集時の混入防止）
  if (currentSide === "買") {
    trade.entryTag = currentEntryTag;
    trade.entryNote = $("f-entry-note").value.trim() || null;
    trade.exitTag = null;
    trade.exitNote = null;
  } else {
    trade.exitTag = currentExitTag;
    trade.exitNote = $("f-exit-note").value.trim() || null;
    trade.entryTag = null;
    trade.entryNote = null;
  }
  if (editingId) store.updateTrade(editingId, trade);
  else store.addTrade(trade);
  closeForm();
  renderAll();
  saveToDrive();
  refreshIndicators(); // 新しい買い銘柄のスナップショットを取りに行く
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

  // タグchip（選択トグル / ＋新規）
  $("entry-tags").addEventListener("click", onTagChipClick);
  $("exit-tags").addEventListener("click", onTagChipClick);

  // 型別成績の軸切替（主観タグ / 客観スナップショット）
  $("tag-axis").addEventListener("change", (e) => {
    tagAxis = e.target.value;
    renderTagBreakdown();
  });

  // 未取得銘柄コードのコピー（監視リストへ貼り付けやすい形式）
  $("missing-copy").addEventListener("click", async (e) => {
    const text = e.currentTarget.dataset.codes || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      e.currentTarget.textContent = "コピーしました";
      setTimeout(() => (e.currentTarget.textContent = "コードをコピー"), 1500);
    } catch (err) {
      console.warn("クリップボードへのコピーに失敗:", err);
      e.currentTarget.textContent = "コピーできませんでした";
      setTimeout(() => (e.currentTarget.textContent = "コードをコピー"), 1500);
    }
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

  // アプリが前面に戻ったら最新株価を取り直して含み損益を更新する。
  // iOSのホーム画面アプリ（PWA）はブラウザのような手動リロードができないため、
  // 復帰イベント起点で再取得し、ブラウザ更新なしで含み損益を最新化する。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshPricesOnForeground();
  });
  window.addEventListener("focus", refreshPricesOnForeground); // PC/一部ブラウザ向けの保険
}

// 前面復帰時の株価リフレッシュ。短時間の連続復帰での無駄な再取得を防ぐためスロットルする。
let _lastPriceRefresh = 0;
async function refreshPricesOnForeground() {
  const now = Date.now();
  if (now - _lastPriceRefresh < 60_000) return; // 60秒以内の再復帰はスキップ
  _lastPriceRefresh = now;
  try {
    const before = getPriceDate();
    await loadPrices(); // ネットワーク優先（SW設定）。失敗時は前回値のまま。
    // 価格は renderHoldings 内で getPriceMap() を都度参照するため、再描画で反映される
    renderAll();
    if (before !== getPriceDate()) {
      console.info("最新株価を取得しました:", getPriceDate());
    }
  } catch (e) {
    console.warn("株価の再取得に失敗:", e);
  }
}

// ---------- 起動 ----------
async function init() {
  await Promise.all([loadStocks(), loadPrices()]);
  store.loadCache(); // 直近のキャッシュを表示（オフライン/未サインインでも閲覧可）
  wireEvents();
  renderTagChips();
  renderAll();
  refreshIndicators(); // 客観スナップショットは取得でき次第あとから反映
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
