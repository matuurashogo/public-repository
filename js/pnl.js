// 損益計算ロジック（平均法・税金準拠）
// 副作用のない純粋関数のみ。ブラウザ(import)・Node(node:test)双方から利用する。

// 譲渡益課税の概算税率: 所得税15% + 復興特別所得税0.315% + 住民税5%
export const TAX_RATE = 0.20315;

// 概算税額（純利益がプラスのときのみ課税。損失は0）
export function estimateTax(grossProfit) {
  if (grossProfit <= 0) return 0;
  return Math.round(grossProfit * TAX_RATE);
}

// 取引配列から実現損益レコードを計算する（平均法）。
// trades: [{ id, date, code, side("買"/"売"), quantity, price }]
// 戻り値: { records, holdings, warnings }
//   records: 売却ごとの実現損益 [{ date, code, quantity, sellPrice, avgCost, pnl }]
//   holdings: 銘柄ごとの残高 { code: { quantity, cost } }
//   warnings: 警告メッセージ配列
export function calcRealized(trades) {
  const warnings = [];

  // 約定日順（同日は入力順を保つため安定ソート）→ id を副キーにせず元の順序を尊重
  const sorted = trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      if (a.t.date < b.t.date) return -1;
      if (a.t.date > b.t.date) return 1;
      return a.i - b.i;
    })
    .map((x) => x.t);

  const holdings = {}; // code -> { quantity, cost }
  const records = [];

  for (const tr of sorted) {
    const code = String(tr.code);
    const qty = Number(tr.quantity);
    const price = Number(tr.price);
    if (!holdings[code]) holdings[code] = { quantity: 0, cost: 0 };
    const h = holdings[code];

    if (tr.side === "買") {
      h.quantity += qty;
      h.cost += qty * price; // 手数料はMVPでは0円扱い
    } else if (tr.side === "売") {
      let sellQty = qty;
      if (sellQty > h.quantity) {
        warnings.push(
          `${tr.date} ${code}: 保有数量(${h.quantity})を超える売却(${sellQty})です。保有分のみ計算しました。`
        );
        sellQty = h.quantity;
      }
      if (sellQty > 0) {
        const avgCost = h.cost / h.quantity; // 平均取得単価
        const pnl = Math.round(price * sellQty - avgCost * sellQty);
        records.push({
          tradeId: tr.id,
          date: tr.date,
          code,
          quantity: sellQty,
          sellPrice: price,
          avgCost,
          pnl,
        });
        h.cost -= avgCost * sellQty;
        h.quantity -= sellQty;
        if (h.quantity === 0) h.cost = 0; // 浮動小数の誤差を残さない
      }
    }
  }

  return { records, holdings, warnings };
}

// 実現損益レコードを軸で集計する。
// axis: "year" | "month" | "code"
// 戻り値: [{ key, gross, tax, net }]（key昇順。year/monthは降順が見やすいので呼び出し側で調整可）
export function aggregate(records, axis, nameResolver) {
  const buckets = new Map(); // key -> gross
  for (const r of records) {
    let key;
    if (axis === "year") key = r.date.slice(0, 4);
    else if (axis === "month") key = r.date.slice(0, 7); // YYYY-MM
    else if (axis === "code") key = r.code;
    else throw new Error(`unknown axis: ${axis}`);
    buckets.set(key, (buckets.get(key) || 0) + r.pnl);
  }

  const rows = [];
  for (const [key, gross] of buckets.entries()) {
    const tax = estimateTax(gross);
    const row = { key, gross, tax, net: gross - tax };
    if (axis === "code" && typeof nameResolver === "function") {
      row.name = nameResolver(key);
    }
    rows.push(row);
  }

  if (axis === "code") {
    rows.sort((a, b) => b.gross - a.gross); // 損益の大きい順
  } else {
    rows.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)); // 新しい期間が上
  }
  return rows;
}

// 約定日順に実現損益を積み上げた累積系列（グラフ用）
// 戻り値: [{ date, cum }]
export function cumulative(records) {
  const sorted = [...records].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  let cum = 0;
  return sorted.map((r) => {
    cum += r.pnl;
    return { date: r.date, cum };
  });
}

// 2つの ISO 日付文字列(YYYY-MM-DD)間の実日数を返す。
function daysBetween(fromISO, toISO) {
  const a = new Date(fromISO + "T00:00:00");
  const b = new Date(toISO + "T00:00:00");
  return Math.round((b - a) / 86400000);
}

// FIFO で買いロットと売りを突き合わせ、売却(tradeId)ごとの株数加重の
// 平均保有日数（実日数）を返す。損益は平均法だが保有期間は日数定義が
// 自然な FIFO で算出する（設計ドキュメント参照）。
// 戻り値: Map<tradeId, holdingDays>
export function holdingDaysBySell(trades) {
  const sorted = trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      if (a.t.date < b.t.date) return -1;
      if (a.t.date > b.t.date) return 1;
      return a.i - b.i;
    })
    .map((x) => x.t);

  const lots = {}; // code -> [{ date, qty }]（古い順の待ち行列）
  const result = new Map();

  for (const tr of sorted) {
    const code = String(tr.code);
    const qty = Number(tr.quantity);
    if (!lots[code]) lots[code] = [];

    if (tr.side === "買") {
      lots[code].push({ date: tr.date, qty });
    } else if (tr.side === "売") {
      let remaining = qty;
      let dayQty = 0; // Σ(日数 × 株数)
      let matchedQty = 0; // 突き合わせできた株数
      const queue = lots[code];
      while (remaining > 0 && queue.length > 0) {
        const lot = queue[0];
        const take = Math.min(remaining, lot.qty);
        dayQty += daysBetween(lot.date, tr.date) * take;
        matchedQty += take;
        lot.qty -= take;
        remaining -= take;
        if (lot.qty === 0) queue.shift();
      }
      if (matchedQty > 0) result.set(tr.id, dayQty / matchedQty);
    }
  }
  return result;
}

// 平均(空配列は null を返す)
function mean(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

// トレード成績(KPI)を計算する。すべて実現損益ベース。
// year を渡すとその年の売却に限定する(例 "2026")。省略時は全期間。
// 戻り値: 各指標(該当データが無い項目は null)
export function calcKpis(trades, year) {
  const { records } = calcRealized(trades);
  const sells = year ? records.filter((r) => r.date.slice(0, 4) === year) : records;

  const wins = sells.filter((r) => r.pnl > 0);
  const losses = sells.filter((r) => r.pnl < 0);
  const sellCount = sells.length;
  const buyCount = trades.filter(
    (t) => t.side === "買" && (!year || t.date.slice(0, 4) === year)
  ).length;

  const winRate = sellCount > 0 ? wins.length / sellCount : null;
  const avgWin = mean(wins.map((r) => r.pnl)); // 正 or null
  const avgLoss = mean(losses.map((r) => r.pnl)); // 負 or null
  const payoffRatio =
    avgWin !== null && avgLoss !== null && avgLoss !== 0
      ? avgWin / Math.abs(avgLoss)
      : null;
  const expectancy = mean(sells.map((r) => r.pnl)); // 平均 pnl = 期待値/売却

  // 最大ドローダウン（今年の累積実現損益のピーク→谷の最大幅）
  const series = cumulative(sells);
  let peak = 0;
  let maxDrawdown = 0;
  for (const p of series) {
    if (p.cum > peak) peak = p.cum;
    const dd = peak - p.cum;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 平均保有期間（全体／勝ち／負け）
  const holdMap = holdingDaysBySell(trades);
  const holdAll = [];
  const holdWin = [];
  const holdLoss = [];
  for (const r of sells) {
    const d = holdMap.get(r.tradeId);
    if (d === undefined) continue;
    holdAll.push(d);
    if (r.pnl > 0) holdWin.push(d);
    else if (r.pnl < 0) holdLoss.push(d);
  }

  return {
    sellCount,
    buyCount,
    winRate, // 0..1 or null
    winningCount: wins.length,
    losingCount: losses.length,
    avgWin, // 正 or null
    avgLoss, // 負 or null
    payoffRatio, // 倍 or null
    expectancy, // 円/売却 or null
    maxDrawdown, // 円（>=0）
    avgHoldDays: mean(holdAll), // 日 or null
    avgHoldDaysWin: mean(holdWin),
    avgHoldDaysLoss: mean(holdLoss),
    pnls: sells.map((r) => r.pnl), // ヒストグラム用
  };
}
