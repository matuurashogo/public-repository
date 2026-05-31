// 最新終値の読み込み（同梱の data/latest_prices.json を参照）。
// 保有銘柄の含み損益（評価損益）算出に使う。API不要・オフライン可。
// データの正は別リポ jquants-data（GitHub Actions で日次更新して同梱）。

let _prices = {}; // { code: number }
let _date = ""; // 基準日 YYYY-MM-DD
let _source = "";

export async function loadPrices() {
  try {
    const res = await fetch("./data/latest_prices.json", { cache: "no-cache" });
    if (res.ok) {
      const data = await res.json();
      _prices = (data && data.prices) || {};
      _date = (data && data.date) || "";
      _source = (data && data.source) || "";
    }
  } catch (e) {
    // 取得できなくても致命的ではない（含み損益が出ないだけ）
    console.warn("latest_prices.json の読み込みに失敗:", e);
  }
  return _prices;
}

// 4桁コード→最新終値。未収録は undefined。
export function codeToPrice(code) {
  return _prices[String(code)];
}

// priceMap 全体（calcUnrealized に渡す用）
export function getPriceMap() {
  return _prices;
}

// 価格の基準日（YYYY-MM-DD）。未取得時は空文字。
export function getPriceDate() {
  return _date;
}

export function getPriceSource() {
  return _source;
}
