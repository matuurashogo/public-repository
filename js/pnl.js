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
