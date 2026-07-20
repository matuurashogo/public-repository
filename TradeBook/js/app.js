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
import { parseTradeText, normalizeOcrText } from "./parse.js";
import { loadPrices, getPriceMap, getPriceDate } from "./prices.js";
import { calcRealized, aggregate, calcKpis, withMatsuiFees, calcUnrealized, tagBreakdown, entryTagAttribution, summarize, accountMixWarnings } from "./pnl.js";
import { prefetchIndicators, loadIndicator, getSnapshot, bucketOf, indicatorStatus, latestIndicatorDate, isEntryDataReady, getRows, computeEntryOutcome } from "./indicators.js";
import { MATSUI_BOX_RATE } from "./config.js";
import { renderCumulative, renderHistogram, renderStockChart } from "./charts.js";
import { buildChartModel, buildDetailSections } from "./detail.js";
import { loadBuyLevels, renderBuyLevels, getBuyLevels } from "./buylevels.js";
import { loadIntradayPrices, freshIntraday } from "./intraday.js";
import { loadVolatility, getVolatility, paramsFromPayload, computeSellTarget } from "./selltarget.js";
import { loadSrLevels, getSrLevels, srForCode, nearestSr, fmtSrDist } from "./srlevels.js";

const store = new Store();
let axis = "month"; // year | month | code
let editingId = null;
const LIST_INITIAL = 30; // 取引履歴の初期表示件数（計算は全件・表示だけ絞る）
const LIST_STEP = 50; // 「もっと見る」で追加表示する件数
let listLimit = LIST_INITIAL;
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
  // TBK-0003: 約定時点の客観スナップショット / TBK-0005: 約定後の結果メトリクスを凍結保存（バックフィル）
  const frozen = freezeEntrySnapshots() + freezeEntryOutcomes();
  renderTagBreakdown();
  renderMissingIndicators();
  renderList(tradesForCalc(), calcRealized(tradesForCalc()).records);
  // 凍結が発生したら正本(Drive)へ永続化する。サインイン中のみ送信、未サインインは
  // ローカルキャッシュ済み（saveToDriveが早期return）。冪等で、凍結ぶんが無い時は走らない。
  if (frozen > 0) saveToDrive();
}

// TBK-0005: 結果メトリクス（MFE/MAE・+5/+20営業日リターン）が確定した買いを凍結保存する。
// horizon(20営業日)ぶんの終値が出揃った(complete)買いのみ対象。未到達は暫定表示のまま据え置く。
function freezeEntryOutcomes() {
  let changed = 0;
  for (const t of store.getTrades()) {
    if (t.side !== "買" || t.entryOutcome) continue;
    const rows = getRows(t.code);
    if (!rows) continue;
    const out = computeEntryOutcome(rows, t.date, t.price, 20); // cost=約定単価（実フィル）
    if (!out || !out.complete) continue;
    store.setEntryOutcome(t.id, {
      cost: out.cost, ret5: out.ret5, ret20: out.ret20,
      mfe: out.mfe, mae: out.mae, asOf: out.asOf, horizon: out.horizon,
    });
    changed++;
  }
  return changed;
}

// 買いの結果メトリクスを取得する。凍結値(TBK-0005)を優先し、無ければ終値系列から暫定計算。
function entryOutcomeForBuy(trade) {
  if (trade.entryOutcome) return { ...trade.entryOutcome, provisional: false };
  const out = computeEntryOutcome(getRows(trade.code), trade.date, trade.price, 20);
  return out ? { ...out, provisional: true } : null;
}

// TBK-0003: 未凍結の買いに、約定時点の客観スナップショットを焼き込む。
// データが取得済み(ok)の銘柄のみ対象。未取得/欠損は次回に再試行する。
// 永続化はローカルへ即時（updatedAt更新）、Driveへは次回同期で伝播する。
function freezeEntrySnapshots() {
  let changed = 0;
  for (const t of store.getTrades()) {
    if (t.side !== "買" || t.entrySnap) continue;
    if (indicatorStatus(t.code) !== "ok") continue;
    // 約定日ぶんの客観データが出揃うまで凍結しない（j-quantsはEOD＝当日日中は前日まで）。
    // 最新営業日が約定日に追いついたら凍結する。それまではライブ引き当てで暫定表示。
    if (!isEntryDataReady(latestIndicatorDate(t.code), t.date)) continue;
    const s = getSnapshot(t.code, t.date);
    if (!s) continue;
    store.setEntrySnap(t.id, {
      dev: s.dev, abv: s.abv, vol: s.vol, rsi: s.rsi, hv: s.hv, asOf: s.date,
    });
    changed++;
  }
  return changed;
}

// 買いの客観スナップショットを取得する。凍結値(TBK-0003)を優先し、無ければライブ引き当て。
function entrySnapForBuy(trade) {
  if (trade.entrySnap) return trade.entrySnap;
  return getSnapshot(trade.code, trade.date);
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
  renderMascot(records);
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

// 保有銘柄カード: 銘柄 / 保有数 / 取得→現在 / 含み損益 / 利確目標（評価額の大きい順）。
// holdings は calcRealized が返す { code: { quantity, cost } }。
// 最新終値（latest_prices.json）があれば含み損益（未実現）を併記し、合計と基準日も表示する。
// 利確目標セル（ボラ連動・TBK-0010・表示専用）。σ20が無ければ「—」。
// 主役は売り判断に効く「あと +X%」/「🎯到達」。目標価格は下に小さく添える。
// title に「目標幅 +W%（σ連動）」を出す。
function sellTargetCell(avgCost, currentPrice, sigma, params, yen) {
  const t = computeSellTarget(avgCost, currentPrice, sigma, params);
  if (!t) return `<td class="muted">—</td>`;
  let main = "";
  if (t.dist !== null) {
    main = t.hit
      ? `<span class="h-tp-hit ${gainLossClass(1)}">🎯到達</span>`
      : `<span class="h-tp-dist">あと ${formatPct(t.dist)}</span>`;
  }
  const target = `<span class="h-tp-target">目標 ${yen(t.targetPrice)}</span>`;
  return `<td class="h-tp" title="${esc(`目標幅 ${formatPct(t.width)}（σ連動）`)}">${main}${target}</td>`;
}

// 支持線・抵抗線セル（TBK-0014・表示専用）。現在値に最も近い抵抗線（上）と支持線（下）を
// 2段で出す。currentPrice が水準を跨いでいれば nearestSr が振り分け直す。データ無しは「—」。
function srCell(code, currentPrice, yen) {
  const sr = srForCode(getSrLevels(), code);
  const { support, resistance } = nearestSr(sr, currentPrice);
  if (!support && !resistance) return `<td class="muted">—</td>`;
  const res = resistance
    ? `<span class="h-sr-res" title="抵抗線（上値の節目・スイング高値/安値）">R ${yen(resistance.price)} <span class="h-sr-dist">${fmtSrDist(resistance.dist)}</span></span>`
    : `<span class="h-sr-res muted">R —</span>`;
  const sup = support
    ? `<span class="h-sr-sup" title="支持線（下値の節目・スイング高値/安値）">S ${yen(support.price)} <span class="h-sr-dist">${fmtSrDist(support.dist)}</span></span>`
    : `<span class="h-sr-sup muted">S —</span>`;
  return `<td class="h-sr">${res}${sup}</td>`;
}

// ---------- 銘柄詳細モーダル（TBK 詳細モーダル） ----------

// 現在値を取得（場中が新鮮なら場中・無ければ終値）。戻り値 { price, isIntraday }。
function currentPriceOf(code) {
  const intraday = freshIntraday();
  const iv = intraday && intraday.prices ? Number(intraday.prices[String(code)]) : NaN;
  if (Number.isFinite(iv) && iv > 0) return { price: iv, isIntraday: true };
  const cv = Number(getPriceMap()[String(code)]);
  return { price: Number.isFinite(cv) && cv > 0 ? cv : null, isIntraday: false };
}

// その銘柄の保有情報（含み損益つき行）を返す。非保有は null。
function holdingRowOf(code) {
  const { holdings } = calcRealized(tradesForCalc());
  const intraday = freshIntraday();
  const priceMap = intraday ? { ...getPriceMap(), ...intraday.prices } : getPriceMap();
  const { rows } = calcUnrealized(holdings, priceMap);
  return rows.find((r) => String(r.code) === String(code)) || null;
}

// 詳細モーダルを開く。indicators は遅延取得（監視リスト外なら null＝チャートなし表示）。
async function openStockDetail(code) {
  code = String(code);
  const modal = $("detail-modal");
  if (!modal) return;

  // 先に骨組みを見せる（データ取得を待たせない）
  $("detail-title").textContent = codeToName(code) || "（名称未登録）";
  $("detail-code").textContent = code;
  showDetailModal();

  // 指標系列を遅延取得（監視リスト銘柄のみ存在。無ければ null）
  await loadIndicator(code);
  const rows = getRows(code);
  const sr = srForCode(getSrLevels(), code);
  const buyStock = (getBuyLevels()?.stocks || []).find((s) => String(s.code) === code) || null;
  const vol = getVolatility();
  const sigma = vol && vol.sigma ? vol.sigma[code] : undefined;
  const { price, isIntraday } = currentPriceOf(code);
  const holding = holdingRowOf(code);
  const snapshot = rows && rows.length ? rows[rows.length - 1] : null;

  // チャート（終値＋S/R横線）
  const chartModel = buildChartModel(rows, sr);
  const note = $("detail-chart-note");
  if (chartModel.hasData) {
    note.hidden = true;
    renderStockChart($("detail-chart"), chartModel);
  } else {
    // 監視リスト外などデータ無し: キャンバスを消して注記を出す
    renderStockChart($("detail-chart"), { hasData: false });
    note.hidden = false;
    note.textContent = "チャートデータがありません（監視リストに追加すると翌営業日から表示されます）。";
  }

  // 現在値
  const priceEl = $("detail-price");
  if (price != null) {
    const label = isIntraday && freshIntraday() ? `${esc(freshIntraday().label)}時点` : "終値";
    priceEl.innerHTML = `<span class="detail-px-val">${Math.round(price).toLocaleString("ja-JP")}</span><span class="detail-px-lbl">${label}</span>`;
  } else {
    priceEl.textContent = "現在値の取得不可";
  }

  // 情報セクション（純粋関数で view-model を組み、描画はここで）
  const model = buildDetailSections({
    code,
    name: codeToName(code) || "",
    currentPrice: price,
    priceIsIntraday: isIntraday,
    sr,
    buyStock,
    sigma: typeof sigma === "number" ? sigma : null,
    volParams: paramsFromPayload(vol),
    holding,
    snapshot,
  });
  $("detail-sections").innerHTML = renderDetailSections(model);
}

// view-model → HTML（数値の整形のみ。計算は detail.js / selltarget.js 側で済み）。
function renderDetailSections(m) {
  const blocks = [];
  const pct = (v) => (typeof v === "number" ? fmtSrDist(v) : "—");

  // 含み損益（保有時）
  if (m.holding) {
    const h = m.holding;
    const rate = h.unrealizedRate == null ? "" : ` (${formatPct(h.unrealizedRate)})`;
    const val =
      h.unrealized == null
        ? '<span class="muted">現在値なし</span>'
        : `<span class="${gainLossClass(h.unrealized)}">${formatYen(h.unrealized)}${rate}</span>`;
    blocks.push(detailBlock("保有・含み損益", `
      <div class="d-row"><span>保有数</span><b>${h.quantity.toLocaleString("ja-JP")}株</b></div>
      <div class="d-row"><span>平均取得単価</span><b>${Math.round(h.avg).toLocaleString("ja-JP")}</b></div>
      <div class="d-row"><span>含み損益</span><b>${val}</b></div>`));
  }

  // 支持線・抵抗線
  if (m.sr) {
    const line = (o, cls, mark) =>
      `<div class="d-row"><span>${mark} ${Math.round(o.price).toLocaleString("ja-JP")}</span><b class="${cls}">${pct(o.dist)}</b></div>`;
    const res = m.sr.resistance.map((o) => line(o, "loss", "抵抗")).join("");
    const sup = m.sr.support.map((o) => line(o, "gain", "支持")).join("");
    blocks.push(detailBlock("支持線・抵抗線", (res || "") + (sup || "") || '<div class="muted">水準なし</div>'));
  }

  // 利確目標（σ連動）
  if (m.sellTarget) {
    const t = m.sellTarget;
    let body = `<div class="d-row"><span>σ20</span><b>${(t.sigma * 100).toFixed(1)}%</b></div>
      <div class="d-row"><span>利確幅（目安）</span><b>${t.width == null ? "—" : formatPct(t.width)}</b></div>`;
    if (t.target) {
      const dist = t.target.dist == null ? "" : `（あと ${formatPct(t.target.dist)}）`;
      const hit = t.target.hit ? '<span class="gain">🎯到達</span>' : "";
      body += `<div class="d-row"><span>利確目標価格</span><b>${Math.round(t.target.targetPrice).toLocaleString("ja-JP")} ${hit}${dist}</b></div>`;
    }
    blocks.push(detailBlock("利確目標（ボラ連動）", body));
  }

  // 買いレベル L1〜L6
  if (m.buyLevels && m.buyLevels.length) {
    const rows = m.buyLevels
      .map((lv) => {
        const state = lv.hit ? '<span class="gain">到達</span>' : lv.dist == null ? "" : `あと ${(-lv.dist * 100).toFixed(1)}%`;
        return `<div class="d-row"><span>${esc(lv.label)}</span><b>${Math.round(lv.price).toLocaleString("ja-JP")} <small>${state}</small></b></div>`;
      })
      .join("");
    blocks.push(detailBlock("買いレベル", rows));
  }

  // 客観指標スナップショット
  if (m.indicators) {
    const i = m.indicators;
    const fmt = (v, f) => (v == null ? "—" : f(v));
    blocks.push(detailBlock(`客観指標${i.asOf ? `（${esc(i.asOf)}）` : ""}`, `
      <div class="d-row"><span>25日線乖離</span><b>${fmt(i.dev, (v) => fmtSrDist(v))}</b></div>
      <div class="d-row"><span>75日線</span><b>${i.abv == null ? "—" : i.abv ? "上（上昇基調）" : "下"}</b></div>
      <div class="d-row"><span>出来高（20日平均比）</span><b>${fmt(i.vol, (v) => v.toFixed(2) + "倍")}</b></div>
      <div class="d-row"><span>RSI(14)</span><b>${fmt(i.rsi, (v) => v.toFixed(1))}</b></div>
      <div class="d-row"><span>年率ボラ(HV)</span><b>${fmt(i.hv, (v) => (v * 100).toFixed(1) + "%")}</b></div>`));
  }

  return blocks.join("") || '<p class="muted">この銘柄の詳細データはまだありません。</p>';
}

function detailBlock(title, innerHtml) {
  return `<div class="detail-block"><div class="detail-block-title">${esc(title)}</div>${innerHtml}</div>`;
}

function showDetailModal() {
  const modal = $("detail-modal");
  modal.hidden = false;
  document.body.classList.add("modal-open");
}
function closeDetailModal() {
  const modal = $("detail-modal");
  if (modal) modal.hidden = true;
  document.body.classList.remove("modal-open");
}

// 場中は intraday_prices.json（約20分遅延・表示専用・TBK-0008）が新鮮なら現在値を上書きする。
function renderHoldings(holdings) {
  const intraday = freshIntraday();
  const priceMap = intraday ? { ...getPriceMap(), ...intraday.prices } : getPriceMap();
  const { rows, total } = calcUnrealized(holdings, priceMap);

  const thead = $("holdings-table").querySelector("thead");
  const tbody = $("holdings-table").querySelector("tbody");
  const note = $("holdings-note");
  const date = getPriceDate();

  // 基準日の注記（価格未取得なら従来の3列にフォールバック）
  const hasPrices = date && rows.some((r) => r.priced);

  // 利確目標（ボラ連動・TBK-0010）。σ20 配信がある時だけ列を出す（無ければ従来表示のまま）。
  const vol = getVolatility();
  const tpParams = paramsFromPayload(vol);
  const sigmaMap = (vol && vol.sigma) || {};
  const hasTp = hasPrices && Object.keys(sigmaMap).length > 0;
  const tpHead = hasTp ? "<th>利確目標</th>" : "";

  // 支持線・抵抗線（TBK-0014）。sr_levels.json の配信がある時だけ列を出す（無ければ従来表示のまま）。
  const hasSr = hasPrices && !!getSrLevels();
  const srHead = hasSr ? "<th>支持/抵抗</th>" : "";

  thead.innerHTML = hasPrices
    ? `<tr><th>銘柄</th><th>保有数</th><th>取得→現在</th><th>含み損益</th>${tpHead}${srHead}</tr>`
    : `<tr><th>銘柄</th><th>保有数</th><th>平均取得単価</th></tr>`;

  if (rows.length === 0) {
    const cols = hasPrices ? 4 + (hasTp ? 1 : 0) + (hasSr ? 1 : 0) : 3;
    tbody.innerHTML = `<tr><td colspan="${cols}" class="table-empty">保有中の銘柄はありません</td></tr>`;
    if (note) note.textContent = "";
    return;
  }

  const yen = (n) => Math.round(n).toLocaleString("ja-JP");
  tbody.innerHTML = rows
    .map((r) => {
      const name = esc(codeToName(r.code) || "（名称未登録）");
      // 銘柄セルは2段（銘柄名は1行省略＋下に小さくコード）。右寄せでの不自然な折り返しを防ぐ。
      const nameCell =
        `<td class="h-name"><span class="h-stock">${name}</span>` +
        `<span class="h-code">${esc(r.code)}</span></td>`;
      const avg = yen(r.avg);
      const qty = `${r.quantity.toLocaleString("ja-JP")}株`;
      const rowOpen = `<tr data-code="${esc(r.code)}" class="tappable-row">`;
      if (!hasPrices) {
        return `${rowOpen}${nameCell}<td>${qty}</td><td>${avg}</td></tr>`;
      }
      // 利確目標（TBK-0010）。取得単価とσ20から目標価格を合成（価格欠損行は現在値なしで目標のみ）。
      const tpCell = hasTp
        ? sellTargetCell(r.avg, r.priced ? r.price : null, sigmaMap[r.code], tpParams, yen)
        : "";
      // 支持線・抵抗線（TBK-0014）。価格欠損行は配信時 close 基準で振り分ける。
      const srTd = hasSr ? srCell(r.code, r.priced ? r.price : null, yen) : "";
      // 取得→現在（B案・圧縮）: 買値と現在値を1セルに。価格欠損行は現在側を「—」。
      const pxCell =
        `<td class="h-px">${avg}<span class="h-arrow">→</span>${r.priced ? yen(r.price) : "—"}</td>`;
      if (!r.priced) {
        return `${rowOpen}${nameCell}<td>${qty}</td>${pxCell}<td class="muted">—</td>${tpCell}${srTd}</tr>`;
      }
      const rate =
        r.unrealizedRate === null ? "" : ` <span class="rate">(${formatPct(r.unrealizedRate)})</span>`;
      return (
        `${rowOpen}${nameCell}<td>${qty}</td>${pxCell}` +
        `<td class="${gainLossClass(r.unrealized)}">${formatYen(r.unrealized)}${rate}</td>${tpCell}${srTd}</tr>`
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
      const basis = intraday ? `${esc(intraday.label)}時点` : `${shortDate}終値`;
      note.innerHTML =
        `${basis} ／ 含み損益 <span class="${cls}">${formatYen(total.unrealized)}</span>円${totalRate}${esc(excluded)}`;
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

// 月キー(YYYY-MM)を「YYYY年M月」表記に整形する。
function monthLabel(key) {
  const [y, m] = key.split("-");
  return `${y}年${Number(m)}月`;
}

// モーション控えめ設定（OS/ブラウザの reduce-motion を尊重）。演出はこれを必ず通す。
function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ヒーロー金額のカウントアップ。前回値→目標値を easeOutCubic で約450msトゥイーン。
// reduce-motion時・同値・初回は即時確定。タブ高速切替に備えトークンで前アニメを打ち切る。
let lastHeroMain = 0;
let heroAnimToken = 0;
function animateHeroValue(hv, target) {
  const yen = '<span class="yen">円</span>';
  const from = lastHeroMain;
  lastHeroMain = target;
  const token = ++heroAnimToken;
  if (prefersReducedMotion() || from === target) {
    hv.innerHTML = formatYen(target) + yen;
    return;
  }
  const dur = 450;
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function frame(now) {
    if (token !== heroAnimToken) return; // 新しい描画に取って代わられた
    const p = Math.min(1, (now - t0) / dur);
    hv.innerHTML = formatYen(from + (target - from) * ease(p)) + yen;
    if (p < 1) requestAnimationFrame(frame);
    else hv.innerHTML = formatYen(target) + yen;
  }
  requestAnimationFrame(frame);
}

// 集計軸の並び（タブのDOM順＝スワイプの送り順）
const AXIS_ORDER = ["year", "month", "code"];

// 集計軸を切り替える。タブのクリックと横スワイプで共通利用。
// dir>0=右へ送る(次の軸) / dir<0=左へ(前の軸)。省略時は並び順から自動判定し、スライド演出を付ける。
function setAxis(newAxis, dir) {
  if (!newAxis || newAxis === axis) return;
  if (dir === undefined) dir = AXIS_ORDER.indexOf(newAxis) - AXIS_ORDER.indexOf(axis);
  axis = newAxis;
  for (const b of $("seg").querySelectorAll("button")) {
    const on = b.dataset.axis === axis;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
  renderAll();
  // 切替方向に応じて中身をスッとスライドさせる（reduce-motion時は無し）
  if (dir && !prefersReducedMotion()) {
    const el = $("summary-content");
    if (el) {
      const cls = dir > 0 ? "slide-left" : "slide-right";
      el.classList.remove("slide-left", "slide-right");
      void el.offsetWidth; // 連続切替でも再生し直す
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), 320);
    }
  }
}

// サマリーカードの横スワイプで隣の軸へ。縦スクロールは妨げない（横方向が明確なときだけ反応）。
function enableAxisSwipe() {
  const el = $("summary-content");
  if (!el) return;
  let x0 = null;
  let y0 = null;
  el.addEventListener("pointerdown", (e) => {
    x0 = e.clientX;
    y0 = e.clientY;
  });
  el.addEventListener("pointerup", (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    x0 = y0 = null;
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.4) return; // 横方向の明確なスワイプのみ
    const i = AXIS_ORDER.indexOf(axis);
    const ni = dx < 0 ? i + 1 : i - 1; // 左へスワイプ=次の軸
    if (ni < 0 || ni >= AXIS_ORDER.length) return; // 端ではクランプ（ループしない）
    setAxis(AXIS_ORDER[ni], dx < 0 ? 1 : -1);
  });
}

function renderSummary(records) {
  const isYear = axis === "year";
  const rows = aggregate(records, axis, codeToName);

  // ヒーロー（大きい数字）は「選択中タブの先頭バケット」にフォーカスする。
  //   年→最新年 / 月→最新月 / 銘柄→損益トップ銘柄
  const fallbackKey =
    axis === "month" ? currentMonthKey() : axis === "code" ? null : String(new Date().getFullYear());
  const hero = rows[0] || { key: fallbackKey, gross: 0, tax: 0, net: 0, rate: null, name: null };

  // 先頭バケットの見出し
  let heroPeriod;
  if (axis === "year") heroPeriod = `${hero.key}年`;
  else if (axis === "month") heroPeriod = hero.key ? monthLabel(hero.key) : "—";
  else heroPeriod = hero.name ? `${hero.name}（${hero.key}）` : hero.key || "—";

  // 大きい数字: 年は税引後、月・銘柄は税引前（税は年単位でのみ意味を持つため）
  const heroMain = isYear ? hero.net : hero.gross;
  $("hero-label").textContent = `${heroPeriod} ${isYear ? "税引後損益" : "損益"}`;
  const hv = $("hero-value");
  hv.className = "value " + gainLossClass(heroMain);
  animateHeroValue(hv, heroMain); // 0→目標へカウントアップ（reduce-motion時は即時）

  // サブ（税引前 / 概算税）は年タブのみ表示。月・銘柄タブでは非表示。
  const sub = document.querySelector(".summary-sub");
  if (sub) sub.style.display = isYear ? "" : "none";
  if (isYear) {
    const hg = $("hero-gross");
    hg.className = "v " + gainLossClass(hero.gross);
    hg.innerHTML =
      formatYen(hero.gross) +
      (hero.rate != null ? ` <span class="rate">(${formatPct(hero.rate)})</span>` : "");
    $("hero-tax").textContent = hero.tax > 0 ? "−" + hero.tax.toLocaleString("ja-JP") : "0";
  }

  // 集計表
  // 申告分離課税は年単位・全銘柄通算後のネットにかかるため、税額は「年」軸でのみ表示する。
  // 月別・銘柄別は誤解を避けて税引前のみ表示する。
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

// ---------- マスコット（Claudey） ----------
// 今月の「確定損益（税引前）」に応じて表情を出し分け、コメントは起動ごとに一度だけ抽選する。
// しきい値は後から調整しやすいよう定数化（円）。
const MASCOT_BIG_WIN = 100000; // この額以上の確定益で「大勝ち」
const MASCOT_BIG_LOSS = -100000; // この額以下の確定損で「大負け（寄り添い）」

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// 今月の確定損益から { tier(コメント区分), face(表情), gross } を返す
function monthMascotState(records) {
  const key = currentMonthKey();
  const row = aggregate(records, "month").find((r) => r.key === key);
  if (!row) return { tier: "none", face: "none", gross: null };
  const g = row.gross;
  if (g >= MASCOT_BIG_WIN) return { tier: "great", face: "great", gross: g };
  if (g > 0) return { tier: "good", face: "good", gross: g };
  if (g === 0) return { tier: "flat", face: "flat", gross: g };
  if (g > MASCOT_BIG_LOSS) return { tier: "down", face: "down", gross: g };
  return { tier: "bigdown", face: "down", gross: g };
}

// オリジナルSVGキャラ（外部画像なし＝PWAオフライン維持）。表情だけ差し替える。
// 配色: ハニー(#EFC15A)。頭上のきらめき(アスタリスク)はClaudeyの目印。
function mascotFace(mood) {
  const body = "#EFC15A"; // 体（やさしい黄色）
  const edge = "#D9A23A"; // きらめき・縁
  const ink = "#3b2a23";
  const cheek = "#FF9E7D";
  // 頭の上のきらめき（Anthropicのアスタリスク風）
  const spark = `<g class="mascot-spark" transform="translate(36 9)" stroke="${edge}" stroke-width="2.6" stroke-linecap="round">` +
    `<line x1="0" y1="-6.5" x2="0" y2="6.5"/>` +
    `<line x1="-5.6" y1="-3.2" x2="5.6" y2="3.2"/>` +
    `<line x1="5.6" y1="-3.2" x2="-5.6" y2="3.2"/></g>`;
  const blob = `<rect x="12" y="20" width="48" height="42" rx="21" fill="${body}"/>`;
  const cheeks = `<ellipse cx="22.5" cy="46" rx="4.3" ry="3" fill="${cheek}" opacity=".7"/>` +
    `<ellipse cx="49.5" cy="46" rx="4.3" ry="3" fill="${cheek}" opacity=".7"/>`;
  // ハイライト付きの目（うるうる）
  const eye = (cx, cy, r) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${ink}"/>` +
    `<circle cx="${cx - r * 0.35}" cy="${cy - r * 0.45}" r="${r * 0.38}" fill="#fff"/>`;
  let eyes;
  let mouth;
  let extra = "";
  switch (mood) {
    case "great":
      eyes = `<path d="M24.5 40 q3.5 -5.5 7 0" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>` +
        `<path d="M40.5 40 q3.5 -5.5 7 0" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
      mouth = `<path d="M27 46 q9 11 18 0 q-9 4 -18 0 z" fill="${ink}"/>`;
      extra = `<g fill="#FFD36B"><circle cx="13" cy="24" r="1.8"/><circle cx="59" cy="28" r="1.8"/>` +
        `<circle cx="56" cy="18" r="1.2"/></g>`;
      break;
    case "good":
      eyes = eye(28, 39, 4) + eye(44, 39, 4);
      mouth = `<path d="M28.5 47 q7.5 7 15 0" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
      break;
    case "flat":
      eyes = eye(28, 39, 3.8) + eye(44, 39, 3.8);
      mouth = `<line x1="31" y1="49" x2="41" y2="49" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
      break;
    case "down":
      eyes = eye(28, 40.5, 3.5) + eye(44, 40.5, 3.5) +
        `<path d="M23.5 35.5 L31 32.5" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>` +
        `<path d="M41 32.5 L48.5 35.5" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`;
      mouth = `<path d="M31 51 q5 3.5 10 0" fill="none" stroke="${ink}" stroke-width="2.8" stroke-linecap="round"/>`;
      extra = `<path d="M50.5 44 q2.3 4.2 0 7.2 q-2.3 -3 0 -7.2 z" fill="#7FC9FF" opacity=".85"/>`;
      break;
    default: // none（今月まだ確定なし）= きょとん
      eyes = eye(28, 39, 4.2) + eye(44, 39, 4.2);
      mouth = `<ellipse cx="36" cy="49" rx="2.4" ry="2.8" fill="${ink}"/>`;
  }
  return `<svg viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">${spark}${blob}${cheeks}${extra}<g class="mascot-eyes">${eyes}</g>${mouth}</svg>`;
}

// 通常コメント（区分ごと・励まし寄り）。毎回ランダムに1つ選ぶ。
const MASCOT_NORMAL = {
  none: [
    "今月はこれから！まっさらな帳簿、いい予感がするよ📓",
    "ノーポジは最強のポジション、なんてね。出番を待ってる！",
    "今月の一手目、楽しみにしてるよ🙌",
    "焦らず、いい球が来るまで待とう⚾",
    "まだ何も確定してないけど、君の判断を信じてる！",
  ],
  great: [
    "今月、絶好調じゃないか！その調子だ🔥",
    "ナイストレード！利益はちゃんと自分を褒めてあげて🎉",
    "読みがバチッとハマったね、お見事！",
    "勝ってる時こそ平常心。でも今日は素直に喜ぼう✨",
    "君のシナリオ通り。実力だよ、これは💪",
    "最高の月になってきた！この勢い、大事にしよう🚀",
  ],
  good: [
    "プラスで終えられてるの、立派だよ👍",
    "コツコツが一番強い。いい積み上げだね",
    "勝ちは勝ち！小さくても胸を張っていこう😊",
    "着実だね。淡々と続けるのが正解だよ",
    "うん、いい流れ。次も自分のルールで🙆",
  ],
  flat: [
    "トントン、悪くないよ。退場しないのが何より大事",
    "プラマイゼロは「生き残った」ってこと。十分えらい",
    "守りきった月。資金が残れば次がある🛡️",
    "焦って動かなかった君、ナイス我慢！",
  ],
  down: [
    "今月はちょっと向かい風。でも大丈夫、想定内さ🍃",
    "負けは授業料。次に活きるよ、必ず",
    "ドローダウンは誰にでもある。淡々といこう",
    "大きく崩れてないのが偉い。リスク管理できてる証拠だよ",
    "深呼吸。ルール通りなら胸を張っていい🌱",
  ],
  bigdown: [
    "しんどい月だったね。でも、君はちゃんと記録を続けてる。それが回復への第一歩だよ",
    "大きく引いた時こそ、一回休んでもいい。相場は逃げない🌙",
    "今日の痛みは、未来の君の糧になる。一緒に立て直そう",
    "数字は厳しいけど、君の価値は損益じゃ決まらないよ。また明日やろう",
    "退場しなければ、いつでも巻き返せる。まずは深呼吸から🫧",
  ],
};

// 激レア（出現確率低め）。区分ごとに用意。
const MASCOT_RARE = {
  none: ["……静寂。嵐の前の、ね。⚡（激レア）"],
  great: [
    "うおおお爆益！画面の前で握手しよう🤝✨（激レア）",
    "本日の主人公は、まちがいなく君だ🏆（激レア）",
  ],
  good: ["勝ちトレード、こっそりハイタッチ🙏（激レア）"],
  flat: ["完全なるイーブン。職人技だね…🧘（激レア）"],
  down: ["転んでもタダでは起きない君が好きだよ🔁（激レア）"],
  bigdown: ["こんな日もある。明日の君に、そっとエールを置いておくね🕯️（激レア）"],
};

// 伝説（超激レア・区分共通）。出会えたらラッキー。
const MASCOT_LEGENDARY = [
  "🌈 伝説コメント 🌈 …君に会えて光栄だ。今日は記念日にしよう。",
  "✨LEGENDARY✨ この瞬間に立ち会えたのは0.5%の幸運。スクショ推奨！📸",
  "👑 帳簿の神が微笑んだ。何が起きても、今日は良い日だ。",
  "🪄 こっそり魔法をかけておいた。次のトレード、ちょっとだけ追い風かも。",
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// レア度抽選つきコメント選択
function pickMascotComment(tier) {
  const r = Math.random();
  if (r < 0.01 && MASCOT_LEGENDARY.length) {
    return { text: pickRandom(MASCOT_LEGENDARY), rarity: "legend" };
  }
  const rare = MASCOT_RARE[tier] || [];
  if (r < 0.07 && rare.length) {
    return { text: pickRandom(rare), rarity: "rare" };
  }
  return { text: pickRandom(MASCOT_NORMAL[tier] || MASCOT_NORMAL.none), rarity: "normal" };
}

// コメントは起動ごとに一度だけ抽選してキャッシュする。
// タブ切替（renderAll の再描画）では引き直さず、今月の状況(tier)が実際に変わったとき
// （取引の追加・削除など）だけ引き直して整合させる。
let mascotCommentCache = null; // { tier, text, rarity }
let recordBubbleUntil = 0; // 自己ベスト演出中はこの時刻まで通常コメントで上書きしない

function renderMascot(records) {
  const el = $("mascot");
  if (!el) return;
  const st = monthMascotState(records);
  el.dataset.mood = st.face;
  $("mascot-figure").innerHTML = mascotFace(st.face);
  // 自己ベスト更新の特別メッセージ表示中は、表情だけ更新して吹き出しは据え置く
  if (Date.now() < recordBubbleUntil) return;
  if (!mascotCommentCache || mascotCommentCache.tier !== st.tier) {
    const picked = pickMascotComment(st.tier);
    mascotCommentCache = { tier: st.tier, text: picked.text, rarity: picked.rarity };
  }
  const c = mascotCommentCache;
  const bubble = $("mascot-bubble");
  bubble.textContent = c.text;
  bubble.className = "mascot-bubble" + (c.rarity !== "normal" ? " " + c.rarity : "");
}

// 保存時のごほうび演出。Claudeyを一度跳ねさせ、ハニー色の紙吹雪を舞わせる。
// 勝ち（利益が出た売却）のときだけ豪華にし、軽い触覚フィードバックも添える。
// すべて内製SVG/CSSで完結（外部アセットなし＝オフラインPWA維持）。
function popMascot() {
  const m = $("mascot");
  if (!m || prefersReducedMotion()) return;
  m.classList.remove("pop");
  void m.offsetWidth; // リフローで連続保存でも再生し直す
  m.classList.add("pop");
  setTimeout(() => m.classList.remove("pop"), 650);
}

// 紙吹雪。level: "normal"=保存 / "win"=利確 / "record"=自己ベスト更新（金系・多め・長め）。
function launchConfetti(level) {
  if (prefersReducedMotion()) return;
  const host = document.querySelector(".summary-hero") || document.body;
  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  const palette =
    level === "record"
      ? ["#FFD36B", "#EFC15A", "#D9A23A", "#FFE9A8", "#FFB23D"] // 金系のお祝い
      : ["#EFC15A", "#D9A23A", "#FFD36B", "#FF9E7D", "#7FC9FF"];
  const count = level === "record" ? 44 : level === "win" ? 26 : 14;
  for (let i = 0; i < count; i++) {
    const p = document.createElement("span");
    p.className = "confetti-piece";
    p.style.left = Math.random() * 100 + "%";
    p.style.background = palette[i % palette.length];
    p.style.animationDelay = Math.random() * 0.2 + "s";
    p.style.animationDuration = 0.9 + Math.random() * 0.6 + "s";
    layer.appendChild(p);
  }
  host.appendChild(layer);
  setTimeout(() => layer.remove(), level === "record" ? 2400 : 1700);
}

function tryVibrate(pattern) {
  if (typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(pattern);
  } catch (_) {}
}

// この売り以外の過去の勝ちトレードの最高益を超えたか（＝単発実現益の自己ベスト更新）。
// 初めての勝ちは「更新」とは呼ばないため、過去に勝ちが1件以上あることを条件にする。
function isNewBestSingle(tradeId, pnl, records) {
  let priorMax = -Infinity;
  let priorWins = 0;
  for (const r of records) {
    if (r.tradeId === tradeId || !(r.pnl > 0)) continue;
    priorWins += 1;
    if (r.pnl > priorMax) priorMax = r.pnl;
  }
  return priorWins > 0 && pnl > priorMax;
}

// 自己ベスト更新の特別メッセージを伝説スタイルで一定時間表示する。
function showRecordBubble() {
  const bubble = $("mascot-bubble");
  if (!bubble) return;
  bubble.textContent = "🏆 自己ベスト更新！単発で過去いちばんの利益だよ、本当にすごい！";
  bubble.className = "mascot-bubble legend";
  recordBubbleUntil = Date.now() + 4500;
  setTimeout(() => {
    recordBubbleUntil = 0;
    renderMascot(calcRealized(tradesForCalc()).records); // 通常コメントへ戻す
  }, 4600);
}

// 新規保存時の演出本体。利確かどうか・自己ベスト更新かを実現損益から判定して強弱を出す。
function celebrateSave(trade) {
  popMascot();
  let level = "normal";
  if (trade && trade.side === "売") {
    try {
      const { records } = calcRealized(tradesForCalc());
      const rec = records.find((r) => r.tradeId === trade.id);
      if (rec && rec.pnl > 0) {
        level = isNewBestSingle(trade.id, rec.pnl, records) ? "record" : "win";
      }
    } catch (_) {
      /* 判定不能なら通常演出のまま */
    }
  }
  if (level === "record") showRecordBubble();
  launchConfetti(level);
  if (level === "record") tryVibrate([30, 40, 30]);
  else if (level === "win") tryVibrate(30);
}

// 直近に保存・編集した取引id。renderList で該当行に flash クラスを付けて光らせる。
// onSubmit がタイムアウトで解除するまで保持し、保存直後の再描画でもハイライトを維持する。
let flashTradeId = null;

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

  const shown = sorted.slice(0, listLimit); // 表示は最新 listLimit 件まで
  list.innerHTML = shown
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
      const snap = !isSell ? entrySnapForBuy(t) : null;
      const snapLine = snap
        ? `<div class="trade-snap"><span class="seg-label">買い場</span>` +
          `<span class="m-seg">乖離 ${formatPct(snap.dev)}</span>${dot}` +
          `<span class="m-seg">${snap.abv ? "75日線上" : "75日線下"}</span></div>`
        : "";

      // 買いは、約定後の結果を MFE/MAE に絞って併記（+5/+20日は分析用に保存・カードは要点のみ）。
      const oc = !isSell ? entryOutcomeForBuy(t) : null;
      const outcomeLine = oc
        ? `<div class="trade-outcome"><span class="seg-label">値動き</span>` +
          `<span class="m-seg"><span class="gain">MFE ${formatPct(oc.mfe)}</span> / ` +
          `<span class="loss">MAE ${formatPct(oc.mae)}</span></span>${dot}` +
          `<span class="m-seg dim">${oc.horizon}日${oc.provisional ? "・暫定" : ""}</span></div>`
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
        `<div class="trade${t.id === flashTradeId ? " flash" : ""}" data-id="${t.id}">` +
        `<div class="left">` +
        `<div class="name">${name}<span class="code">${esc(t.code)}</span>${nisa}</div>` +
        `<div class="meta">${meta}</div>${tagBadge}${snapLine}${outcomeLine}</div>` +
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

  // 「もっと見る」: 残りはボタンで追加表示（計算は全件のまま、描画だけ段階的に増やす）
  const moreBtn = $("list-more");
  const remaining = sorted.length - shown.length;
  if (remaining > 0) {
    moreBtn.textContent = `もっと見る（残り${remaining}件）`;
    moreBtn.classList.remove("hidden");
  } else {
    moreBtn.classList.add("hidden");
  }
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

// ---------- 監視銘柄の編集（買い時ボード・TBK-0007） ----------
function renderWatchChips() {
  const wrap = $("bl-watch-chips");
  const codes = store.getWatchlist();
  if (codes.length === 0) {
    wrap.innerHTML = '<span class="summary-note">監視銘柄がありません。下の検索から追加してください。</span>';
    return;
  }
  wrap.innerHTML = codes
    .map((code) => {
      const name = codeToName(code);
      return (
        `<span class="bl-watch-chip">${esc(code)}` +
        (name ? `<span class="bl-watch-chip-name">${esc(name)}</span>` : "") +
        `<button type="button" data-watch-del="${esc(code)}" aria-label="${esc(code)} を監視から外す">×</button></span>`
      );
    })
    .join("");
}

function hideWatchSuggest() {
  const list = $("bl-watch-suggest");
  list.hidden = true;
  list.innerHTML = "";
}

function renderWatchSuggest(query) {
  const list = $("bl-watch-suggest");
  const items = searchStocks(query, 6);
  if (!String(query || "").trim() || items.length === 0) {
    hideWatchSuggest();
    return;
  }
  list.innerHTML = items
    .map((e) => `<li data-watch-add="${esc(e.code)}"><span>${esc(e.name || "")}</span><span>${esc(e.code)}</span></li>`)
    .join("");
  list.hidden = false;
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
  } else if (p.name) {
    // コード数字が読めなくても社名から逆引きで補完（OCRで数字が化けたとき有効）
    const hit = searchStocks(p.name)[0];
    if (hit) {
      $("f-code").value = hit.code;
      updateNamePreview();
      got.push(`コード(社名「${p.name}」から推定)`);
    } else miss.push("コード");
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
    // 読める形に正規化して表示（丸数字→数字など）。外したら手直し→「貼り付けを解析」で再実行可。
    $("f-paste").value = normalizeOcrText(text);
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
  const saved = editingId ? store.updateTrade(editingId, trade) : store.addTrade(trade);
  flashTradeId = saved ? saved.id : null; // 保存した行を一瞬ハイライト（新規・編集とも）
  closeForm();
  renderAll();
  if (!editingId && saved) celebrateSave(saved); // 新規追加のみ祝う（編集は静かに）
  // 保存直後は指標取得などで再描画が走るため、少しの間フラッシュ対象を保持して光らせ続ける
  if (flashTradeId) setTimeout(() => { flashTradeId = null; }, 1200);
  saveToDrive();
  refreshIndicators(); // 新しい買い銘柄のスナップショットを取りに行く
}

// ---------- イベント結線 ----------
// 買いボード・保有カードの行タップ→「詳細を見る」ボタン→モーダル（TBK 詳細モーダル）。
// テーブル要素にデリゲートで1回だけ配線（tbody は再描画されるが table 自体は残る）。
function wireDetailTaps() {
  for (const tableId of ["buylevels-table", "holdings-table"]) {
    const table = $(tableId);
    if (!table) continue;
    table.addEventListener("click", (e) => {
      const btn = e.target.closest(".row-detail-btn");
      if (btn) {
        openStockDetail(btn.dataset.code);
        return;
      }
      const tr = e.target.closest("tr[data-code]");
      if (tr && table.contains(tr)) toggleRowDetailButton(tr);
    });
  }
  // モーダルを閉じる（×・オーバーレイ・Esc）
  const modal = $("detail-modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target.closest("[data-detail-close]")) closeDetailModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal && !modal.hidden) closeDetailModal();
  });
}

// タップした行の直後に「詳細を見る」アクション行をトグル表示する。
function toggleRowDetailButton(tr) {
  const tbody = tr.parentElement;
  if (!tbody) return;
  const code = tr.dataset.code;
  const existing = tbody.querySelector("tr.row-detail-action");
  const wasForThis = existing && existing.previousElementSibling === tr;
  if (existing) existing.remove();
  tr.classList.remove("row-active");
  if (wasForThis) return; // 同じ行の再タップ → 閉じるだけ
  tbody.querySelectorAll("tr.row-active").forEach((r) => r.classList.remove("row-active"));
  const cols = tr.children.length;
  const ar = document.createElement("tr");
  ar.className = "row-detail-action";
  ar.innerHTML =
    `<td colspan="${cols}"><button type="button" class="row-detail-btn" data-code="${esc(code)}">` +
    `${esc(codeToName(code) || code)} の詳細を見る 📊</button></td>`;
  tr.after(ar);
  tr.classList.add("row-active");
}

function wireEvents() {
  $("seg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-axis]");
    if (btn) setAxis(btn.dataset.axis);
  });
  enableAxisSwipe();
  wireDetailTaps();

  $("add-toggle").addEventListener("click", () => openForm(null));
  $("form-cancel").addEventListener("click", closeForm);
  $("trade-form").addEventListener("submit", onSubmit);

  // 約定テキストの貼り付け→自動入力（ボタン押下と貼り付け時の両方で解析）
  $("f-paste-btn").addEventListener("click", () => applyParsed(parseTradeText($("f-paste").value)));
  $("f-paste").addEventListener("paste", () =>
    setTimeout(() => applyParsed(parseTradeText($("f-paste").value)), 0)
  );
  // 取引履歴の「もっと見る」（表示件数を増やして再描画）
  $("list-more").addEventListener("click", () => {
    listLimit += LIST_STEP;
    renderAll();
  });

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
    if (!e.target.closest(".bl-watch-add")) hideWatchSuggest();
  });

  // ---- 監視銘柄の編集（買い時ボード・TBK-0007）----
  $("bl-watch-toggle").addEventListener("click", () => {
    const editor = $("bl-watch-editor");
    editor.hidden = !editor.hidden;
    $("bl-watch-toggle").textContent = editor.hidden ? "監視銘柄を編集" : "編集を閉じる";
    if (!editor.hidden) {
      // 初回はボードの現銘柄をシードする（既存の監視銘柄を失わないため。TBK-0007）
      if (store.getWatchlist().length === 0) {
        const payload = getBuyLevels();
        const codes = payload && payload.stocks ? payload.stocks.map((s) => s.code) : [];
        if (codes.length) {
          store.setWatchlist(codes);
          saveToDrive();
        }
      }
      renderWatchChips();
    }
  });
  $("bl-watch-input").addEventListener("input", (e) => renderWatchSuggest(e.target.value));
  $("bl-watch-suggest").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-watch-add]");
    if (!li) return;
    if (store.addWatchCode(li.dataset.watchAdd)) {
      renderWatchChips();
      saveToDrive();
    }
    $("bl-watch-input").value = "";
    hideWatchSuggest();
  });
  $("bl-watch-chips").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-watch-del]");
    if (!btn) return;
    if (store.removeWatchCode(btn.dataset.watchDel)) {
      renderWatchChips();
      saveToDrive();
    }
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

  // 場中はボードを開きっぱなしでも自動更新したいので、表示中だけ数分ごとに
  // 場中価格（TBK-0008・表示専用）を取り直して現在値表示を更新する。
  setInterval(pollIntraday, INTRADAY_POLL_MS);
}

// 場中価格の定期ポーリング間隔（表示専用・TBK-0008）。
const INTRADAY_POLL_MS = 5 * 60_000;

// 表示中のみ場中価格を取り直し、買い時ボードと保有カードの「現在値表示」を更新する。
// タブが裏のときは何もしない（無駄な fetch を避ける）。古い・取得失敗のときは
// freshIntraday() が null を返し、従来どおり終値表示へ静かにフォールバックする。
async function pollIntraday() {
  if (document.visibilityState !== "visible") return;
  try {
    await loadIntradayPrices();
    renderAll();
    renderBuyLevels(getBuyLevels(), codeToName, freshIntraday(), getSrLevels());
  } catch (e) {
    console.warn("場中価格の定期更新に失敗:", e);
  }
}

// 前面復帰時の株価リフレッシュ。短時間の連続復帰での無駄な再取得を防ぐためスロットルする。
let _lastPriceRefresh = 0;
async function refreshPricesOnForeground() {
  const now = Date.now();
  if (now - _lastPriceRefresh < 60_000) return; // 60秒以内の再復帰はスキップ
  _lastPriceRefresh = now;
  try {
    const before = getPriceDate();
    // 終値と場中価格（TBK-0008）を取り直す。失敗時は前回値のまま。
    await Promise.all([loadPrices(), loadIntradayPrices()]);
    // 価格は renderHoldings 内で都度参照するため、再描画で反映される
    renderAll();
    renderBuyLevels(getBuyLevels(), codeToName, freshIntraday(), getSrLevels());
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
  // 買い時ボード（TBK-0006）と場中価格（TBK-0008）と支持線・抵抗線（TBK-0014）。取得でき次第あとから反映
  Promise.all([loadBuyLevels(), loadIntradayPrices(), loadVolatility(), loadSrLevels()]).then(() => {
    renderBuyLevels(getBuyLevels(), codeToName, freshIntraday(), getSrLevels());
    renderAll(); // 場中価格・利確目標（TBK-0010）・支持線/抵抗線を保有カードに反映
  });

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
