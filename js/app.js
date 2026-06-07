// アプリ統合: 起動フロー・保存フロー・描画・イベント
import { Store, mergeMasters } from "./store.js";
import {
  isConfigured,
  isSignedIn,
  signIn,
  signInSilent,
  restoreToken,
  loadMaster,
  saveMaster,
} from "./drive.js";
import { loadStocks, codeToName, searchStocks } from "./stocks.js";
import { parseTradeText } from "./parse.js";
import { loadPrices, getPriceMap, getPriceDate } from "./prices.js";
import { calcRealized, aggregate, calcKpis, withMatsuiFees, calcUnrealized, tagBreakdown, entryTagAttribution, summarize, accountMixWarnings } from "./pnl.js";
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

// セッション失効などでサインインが必要になったとき、サインインバーを再表示する。
function showSigninBar(note) {
  $("signin-bar").classList.remove("hidden");
  if (note) $("signin-note").textContent = note;
}

// ---------- 描画 ----------
function renderAll() {
  const trades = tradesForCalc();
  const { records, warnings, holdings } = calcRealized(trades);
  // 計算時の警告（保有超過売却）＋データ全体の整合警告（口座混在の同時保有）を併せて表示
  renderWarnings(warnings.concat(accountMixWarnings(trades)));
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
  hg.innerHTML =
    formatYen(hero.gross) +
    (hero.rate != null ? ` <span class="rate">(${formatPct(hero.rate)})</span>` : "");
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
      // 税引前損益のセルに損益率（取得原価ベース）を小さく併記する
      const pctSub = r.rate != null ? `<div class="bd-sub">${formatPct(r.rate)}</div>` : "";
      const grossCell = `<td class="${gainLossClass(r.gross)}">${formatYen(r.gross)}${pctSub}</td>`;
      if (!isYear) {
        return `<tr><td>${label}</td>${grossCell}</tr>`;
      }
      return (
        `<tr><td>${label}</td>${grossCell}` +
        `<td>${r.tax > 0 ? r.tax.toLocaleString("ja-JP") : "0"}</td>` +
        `<td class="${gainLossClass(r.net)}">${formatYen(r.net)}</td></tr>`
      );
    })
    .join("");
}

function renderList(trades, records) {
  const pnlById = {};
  const rateById = {};
  for (const r of records) {
    pnlById[r.tradeId] = r.pnl;
    rateById[r.tradeId] = r.costBasis > 0 ? r.pnl / r.costBasis : null;
  }

  const sorted = [...trades].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const list = $("trade-list");
  $("empty-note").classList.toggle("hidden", sorted.length > 0);

  list.innerHTML = sorted
    .map((t) => {
      const name = esc(codeToName(t.code) || "（名称未登録）");
      const isSell = t.side === "売";
      const pnl = pnlById[t.id];
      const rate = rateById[t.id];
      const price = Number(t.price).toLocaleString("ja-JP");
      const nisa = t.account === "NISA" ? `<span class="acct-tag">NISA</span>` : "";
      const label = `${name} ${t.code}`;
      const rtag = isSell ? t.exitTag : t.entryTag;
      const tagBadge = rtag ? `<div class="trade-tag">${esc(rtag)}</div>` : "";

      // メタ情報は単語の途中で改行されないよう、セグメント単位（nowrap）で組み立てる
      const dot = `<span class="m-dot">・</span>`;
      const metaSegs = [esc(t.date.replace(/-/g, "/")), `${esc(t.quantity)}株 @${price}`];
      if (Number(t.fee) > 0) metaSegs.push(`手数料${Number(t.fee).toLocaleString("ja-JP")}`);
      const meta = metaSegs.map((s) => `<span class="m-seg">${s}</span>`).join(dot);

      // 買いは、その日の客観スナップショット（取得済みなら）を併記
      const snap = !isSell ? getSnapshot(t.code, t.date) : null;
      const snapLine = snap
        ? `<div class="trade-snap"><span class="m-seg">データ ${formatPct(snap.dev)}</span>${dot}` +
          `<span class="m-seg">${snap.abv ? "75日線上" : "75日線下"}</span>${dot}` +
          `<span class="m-seg">出来高${snap.vol.toFixed(1)}倍</span></div>`
        : "";

      // 損益行は売却のみ表示（買いは右上の「買」バッジで足りるため金額行は出さない）
      const pnlLine = isSell
        ? `<div class="pnl-line">` +
          (pnl !== undefined
            ? `<span class="pnl-tag ${gainLossClass(pnl)}">${formatYen(pnl)}</span>` +
              (rate != null ? `<span class="rate">(${formatPct(rate)})</span>` : "")
            : `<span class="pnl-tag muted">—</span>`) +
          `</div>`
        : "";

      return (
        `<div class="trade">` +
        `<div class="left">` +
        `<div class="name">${name}<span class="code">${esc(t.code)}</span>${nisa}</div>` +
        `<div class="meta">${meta}</div>${tagBadge}${snapLine}</div>` +
        `<div class="right">` +
        `<div class="right-top">` +
        `<span class="badge ${isSell ? "sell" : "buy"}">${t.side}</span>` +
        `<span class="row-actions">` +
        `<button data-edit="${t.id}" aria-label="${esc(label)} を編集">✏️</button>` +
        `<button data-del="${t.id}" aria-label="${esc(label)} を削除">🗑</button>` +
        `</span></div>` +
        pnlLine +
        `</div></div>`
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
    if (!isSignedIn()) {
      // 401でトークンが破棄され、サイレント再認証も不可だった → 手動サインインへ誘導
      setSync("error", "再サインインが必要");
      showSigninBar("セッションの有効期限が切れました。もう一度サインインしてください。");
    } else {
      setSync("error", "保存に失敗");
    }
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
    if (!isSignedIn()) {
      setSync("error", "再サインインが必要");
      showSigninBar("セッションの有効期限が切れました。もう一度サインインしてください。");
    } else {
      setSync("error", "同期に失敗");
    }
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
  $("f-paste").value = "";
  $("f-paste-note").textContent = "";
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

// 約定テキストの解析結果をフォームへ流し込む。拾えた項目だけ反映し、
// 何が入って何が未取得かを注記に出す（最終確認は人間が行う前提）。
function applyParsed(p) {
  const note = $("f-paste-note");
  if (!p) {
    note.textContent = "読み取れませんでした。フォーマットが違うかもしれません。手入力してください。";
    return;
  }
  const got = [];
  const miss = [];
  if (p.date) { $("f-date").value = p.date; got.push("約定日"); } else miss.push("約定日");
  if (p.code) {
    $("f-code").value = String(p.code).toUpperCase().slice(0, 4);
    updateNamePreview();
    got.push("コード");
  } else miss.push("コード");
  if (p.side) { setSide(p.side); got.push("売買"); } else miss.push("売買");
  if (p.quantity != null) { $("f-qty").value = p.quantity; got.push("数量"); } else miss.push("数量");
  if (p.price != null) { $("f-price").value = p.price; got.push("単価"); } else miss.push("単価");
  if (p.account) { setAccount(p.account); got.push("口座"); } else miss.push("口座");
  note.textContent =
    `自動入力: ${got.join("・") || "なし"}` +
    (miss.length ? ` / 未取得（手入力してください）: ${miss.join("・")}` : "") +
    "。内容を確認してから登録してください。";
}

// 画像（約定詳細のスクショ）をOCRして取引フォームへ流し込む。
// Tesseract.js はサイズが大きいので、このボタンを押したときだけCDNから遅延ロードする。
// ESMの動的importはiOSのPWAで不安定なため、枯れたUMD版をscriptタグで読み込み
// グローバル window.Tesseract を使う。worker/コア/言語データのパスも明示する。
const TESS_VER = "5.1.1";
let _ocrBusy = false;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VER}/dist/tesseract.min.js`;
    s.onload = () =>
      window.Tesseract
        ? resolve(window.Tesseract)
        : reject(new Error("Tesseract未定義"));
    s.onerror = () => reject(new Error("OCRライブラリの読み込みに失敗"));
    document.head.appendChild(s);
  });
}

async function runImageOcr(file) {
  if (!file || _ocrBusy) return;
  _ocrBusy = true;
  const note = $("f-paste-note");
  try {
    note.textContent = "画像を準備中…";
    const canvas = await preprocessForOcr(file);
    note.textContent = "OCRを読み込み中…（初回はデータ取得に時間がかかります）";
    const T = await loadTesseract();
    const worker = await T.createWorker("jpn", 1, {
      workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VER}/dist/worker.min.js`,
      corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5",
      langPath: "https://tessdata.projectnaptha.com/4.0.0",
      logger: (m) => {
        if (m.status === "recognizing text")
          note.textContent = `画像を解析中… ${Math.round((m.progress || 0) * 100)}%`;
      },
    });
    const {
      data: { text },
    } = await worker.recognize(canvas);
    await worker.terminate();
    $("f-paste").value = text; // 生テキストも表示（外したら手直し→「貼り付けを解析」で再実行可）
    applyParsed(parseTradeText(text));
  } catch (e) {
    console.error("OCR失敗:", e);
    const msg = e && e.message ? e.message : String(e);
    note.textContent = `画像の解析に失敗しました（${msg}）。Live Textで文字をコピーして貼り付ける方法も使えます。`;
  } finally {
    _ocrBusy = false;
  }
}

// OCR前処理: ダークテーマ（白文字×黒背景）は精度が落ちるため、
// 平均輝度で暗い画像を判定して反転し、グレースケール化＋適度に拡大する。
function preprocessForOcr(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const longSide = Math.max(img.width, img.height) || 1;
      const scale = Math.min(2, 1600 / longSide) || 1;
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const id = ctx.getImageData(0, 0, w, h);
      const d = id.data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      const dark = sum / (d.length / 4) < 128;
      for (let i = 0; i < d.length; i += 4) {
        let g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        if (dark) g = 255 - g; // 反転して「黒文字 on 白背景」に寄せる
        d[i] = d[i + 1] = d[i + 2] = g;
      }
      ctx.putImageData(id, 0, 0);
      URL.revokeObjectURL(img.src);
      resolve(c);
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error("画像を読み込めませんでした。"));
    };
    img.src = URL.createObjectURL(file);
  });
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
  const code = $("f-code").value.trim().toUpperCase();
  const quantity = Number($("f-qty").value);
  const price = Number($("f-price").value);

  // --- ブロック: 物理的にありえない入力は保存させない ---
  const today = todayLocalISO();
  const hard = [];
  if (!date) hard.push("約定日が未入力です。");
  else if (date > today) hard.push(`約定日が未来の日付（${date}）になっています。`);
  if (!/^[0-9A-Z]{4}$/.test(code)) hard.push("銘柄コードは4桁（数字または英数字）で入力してください。");
  if (!Number.isInteger(quantity) || quantity <= 0) hard.push("数量は1以上の整数で入力してください。");
  if (!(price > 0)) hard.push("価格は0より大きい値で入力してください。");
  if (hard.length) {
    alert("入力を確認してください:\n\n・" + hard.join("\n・"));
    return;
  }

  // --- 確認: ありえるが怪しい入力（OKで強行可。手動入力ミスの大半はここで止める）---
  const soft = [];
  // 重複登録
  const dup = store.getTrades().some(
    (t) =>
      t.id !== editingId &&
      t.date === date &&
      String(t.code) === code &&
      t.side === currentSide &&
      Number(t.quantity) === quantity &&
      Number(t.price) === price
  );
  if (dup) soft.push("同じ内容（日付・コード・売買・数量・価格）の取引が既にあります。二重登録かもしれません。");
  // 存在しない銘柄コード
  if (!codeToName(code)) soft.push(`コード ${code} は銘柄リストに見つかりません。コード違いの可能性があります。`);
  // 単元（100株の倍数でない）
  if (quantity % 100 !== 0) soft.push(`数量 ${quantity} は100株の倍数ではありません。`);
  // 桁違い価格（最新終値から±50%以上の乖離）
  const mkt = Number(getPriceMap()[code]);
  if (mkt > 0) {
    const dev = Math.abs(price - mkt) / mkt;
    if (dev >= 0.5)
      soft.push(
        `価格 ${price.toLocaleString()}円 は最新終値 ${Math.round(mkt).toLocaleString()}円 と${Math.round(dev * 100)}%乖離しています。桁違いかもしれません。`
      );
  }
  // 保有を超える売却（買っていないのに売る／数量超過）。候補を反映して計算し直して判定。
  if (currentSide === "売") {
    const candidate = { id: editingId || "__candidate__", date, code, side: "売", quantity, price, account: currentAccount };
    const prospective = editingId
      ? store.getTrades().map((t) => (t.id === editingId ? { ...t, ...candidate } : t))
      : store.getTrades().concat([candidate]);
    const { warnings: w } = calcRealized(prospective);
    if (w.some((m) => m.startsWith(`${date} ${code}:`)))
      soft.push("この売却は保有数量を超えています（その時点で買い記録が足りない／買っていない可能性）。");
  }
  if (soft.length) {
    const ok = confirm("⚠ 入力に気になる点があります:\n\n・" + soft.join("\n\n・") + "\n\nこのまま登録しますか？");
    if (!ok) return;
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

  // 約定テキストの貼り付け→自動入力（ボタン押下と貼り付け時の両方で解析）
  $("f-paste-btn").addEventListener("click", () => applyParsed(parseTradeText($("f-paste").value)));
  $("f-paste").addEventListener("paste", () =>
    setTimeout(() => applyParsed(parseTradeText($("f-paste").value)), 0)
  );
  // 画像から読み取る（OCR）
  $("f-ocr-btn").addEventListener("click", () => $("f-ocr-file").click());
  $("f-ocr-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = ""; // 同じ画像を選び直しても change が発火するように
    if (f) runImageOcr(f);
  });
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

  if (!isConfigured()) {
    $("signin-note").textContent =
      "現在はローカル保存で動作中。クラウド同期を使うには README の手順で設定してください。";
    setSync("", "未サインイン");
  } else if (restoreToken()) {
    // 保存済みアクセストークンが有効 → 無操作のまま同期（PWA再起動後もログイン維持）。
    syncFromDrive();
  } else {
    // 有効なトークンが無い場合でも、Google側のセッションが生きていれば UI を出さずに
    // 再取得できることがある（主にPC/通常タブ）。iOSのPWAではITPで失敗しうるが、
    // その場合は静かにローカル表示へフォールバックする（従来どおりボタンで手動サインイン）。
    setSync("busy", "サインイン状態を確認中…");
    signInSilent(5000)
      .then(() => syncFromDrive())
      .catch(() => {
        $("signin-note").textContent =
          "いまはこの端末に保存したデータを表示しています。上のボタンをタップすると Google Drive の最新と同期します。";
        setSync("", "ローカル表示中（タップで同期）");
      });
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW登録失敗:", e));
  }
}

init();
