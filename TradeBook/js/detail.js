// 銘柄詳細モーダル（TBK 設計: docs/plans/2026-07-20-stock-detail-modal-design.md）の
// 純粋関数群。DOM 非依存・副作用なしで、既存データ契約（indicators / sr_levels /
// buy_levels / volatility / holdings）から「チャート用モデル」と「情報セクション用モデル」を
// 組み立てる。算術（率・差・目標価格）はここで確定し、テンプレート側では計算しない。

import { computeSellTarget, targetWidth } from "./selltarget.js";

// 終値系列（indicators の rows: [{d, c, ...}] 昇順）＋支持/抵抗（sr）から
// チャート描画モデルを作る。直近 lastN 営業日に絞る（既定 250 ≒ 1年）。
// 戻り値: { labels[], close[], srLines: [{ value, kind("support"|"resistance") }], hasData }
export function buildChartModel(rows, sr, lastN = 250) {
  const clean = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && typeof r.c === "number" && isFinite(r.c) && typeof r.d === "string"
  );
  const tail = lastN > 0 ? clean.slice(-lastN) : clean;
  const labels = tail.map((r) => r.d);
  const close = tail.map((r) => r.c);

  // S/R 横線は「チャートの表示価格域に入る水準」だけ描く（域外の線は情報量ゼロで邪魔）。
  const srLines = [];
  if (close.length) {
    const lo = Math.min(...close);
    const hi = Math.max(...close);
    const pad = (hi - lo) * 0.15 || hi * 0.05 || 1;
    const within = (v) => v >= lo - pad && v <= hi + pad;
    for (const v of sr && Array.isArray(sr.support) ? sr.support : []) {
      if (typeof v === "number" && isFinite(v) && within(v)) srLines.push({ value: v, kind: "support" });
    }
    for (const v of sr && Array.isArray(sr.resistance) ? sr.resistance : []) {
      if (typeof v === "number" && isFinite(v) && within(v)) srLines.push({ value: v, kind: "resistance" });
    }
  }
  return { labels, close, srLines, hasData: close.length > 0 };
}

// 情報セクション用の view-model を組み立てる純粋関数。
// 入力（すべて任意。無いものは対応セクションを null にする）:
//   code, name, currentPrice, priceIsIntraday
//   sr           : sr_levels.json の該当 stock { support[], resistance[] }
//   buyStock     : buy_levels.json の該当 stock { close, rebound, levels[], tsureyasu? }
//   sigma        : volatility.sigma[code]（数値）
//   volParams    : selltarget.paramsFromPayload(volatility)
//   holding      : { quantity, avg, cost, unrealized, unrealizedRate, priced } | null（保有のみ）
//   snapshot     : indicators 最新行 { d, dev, abv, vol, rsi, hv } | null
// 戻り値: セクションごとの整形済みオブジェクト（描画側は数値をそのまま流し込むだけ）。
export function buildDetailSections(input) {
  const {
    code,
    name = "",
    currentPrice = null,
    priceIsIntraday = false,
    sr = null,
    buyStock = null,
    sigma = null,
    volParams = null,
    holding = null,
    snapshot = null,
  } = input || {};

  // 支持線・抵抗線（タッチ回数=信頼度つき・近い順。TBK-0015。距離%は表示しない方針）
  const srSection = (() => {
    if (!sr) return null;
    const withTouches = (prices, touches) =>
      (prices || [])
        .map((v, i) => ({
          price: v,
          touches: Array.isArray(touches) && Number.isFinite(touches[i]) ? touches[i] : 0,
        }))
        .filter((x) => typeof x.price === "number");
    const support = withTouches(sr.support, sr.support_touches);
    const resistance = withTouches(sr.resistance, sr.resistance_touches);
    if (!support.length && !resistance.length) return null;
    return { support, resistance };
  })();

  // 買いレベル L1〜L6（buy_levels の levels をそのまま整形）
  const buyLevels = buyStock && Array.isArray(buyStock.levels)
    ? buyStock.levels.map((lv) => ({
        id: lv.id,
        label: lv.label,
        price: lv.price,
        dist: typeof lv.dist === "number" ? lv.dist : null,
        hit: !!lv.hit,
      }))
    : null;

  // 連れ安度（buy_levels の tsureyasu をそのまま渡す。表示可否は描画側で判定）
  const tsureyasu = buyStock && buyStock.tsureyasu ? buyStock.tsureyasu : null;

  // 利確目標（σ20＋保有取得単価。保有していなければ幅だけ＝目安）。
  // 取得単価より上に抵抗線があれば min(σ目標, 最寄り抵抗線) を採用する（TBK-0016）。
  const sellTarget = (() => {
    if (typeof sigma !== "number" || !volParams) return null;
    const width = targetWidth(sigma, volParams);
    const avg = holding && holding.avg > 0 ? holding.avg : null;
    const t = avg
      ? computeSellTarget(avg, currentPrice, sigma, volParams, sr ? sr.resistance : null)
      : null;
    return { sigma, width, target: t }; // t は保有時のみ（目標価格・到達判定・basis つき）
  })();

  // 客観指標スナップショット（indicators 最新行）
  const indicators = snapshot
    ? {
        asOf: snapshot.d || null,
        dev: typeof snapshot.dev === "number" ? snapshot.dev : null, // 25日線乖離
        abv: typeof snapshot.abv === "boolean" ? snapshot.abv : null, // 75日線上か
        vol: typeof snapshot.vol === "number" ? snapshot.vol : null, // 出来高20日平均比
        rsi: typeof snapshot.rsi === "number" ? snapshot.rsi : null,
        hv: typeof snapshot.hv === "number" ? snapshot.hv : null,
      }
    : null;

  // 含み損益（保有銘柄のみ）
  const holdingSection = holding && holding.quantity > 0
    ? {
        quantity: holding.quantity,
        avg: holding.avg,
        price: holding.priced ? holding.price : null,
        unrealized: holding.priced ? holding.unrealized : null,
        unrealizedRate: holding.priced ? holding.unrealizedRate : null,
      }
    : null;

  return {
    code: String(code),
    name,
    currentPrice,
    priceIsIntraday,
    sr: srSection,
    buyLevels,
    tsureyasu,
    sellTarget,
    indicators,
    holding: holdingSection,
  };
}
