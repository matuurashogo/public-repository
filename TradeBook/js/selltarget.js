// 利確目標（ボラ連動＋抵抗線連動・TBK-0016。初版は TBK-0010/0011）の取得と算出。
// サーバ（gen_volatility.py）が配信する銘柄ごとの σ20 を読み、保有銘柄の取得単価から
// 利確目標価格を「表示専用」で合成する。判定（到達/あと%）も含み益も終値ベース。
// σ目標 = 取得単価 × (1 + min(cap, max(floor, k × σ20)))。取得単価より上に抵抗線があれば
// 目標 = min(σ目標, 最寄り抵抗線)（TBK-0016: 高ボラ株の目標が実運用に対し遠すぎる問題への対処。
// 抵抗線は「そこで止まりやすい価格」の実測値＝手前利確の根拠）。パラメータはハードコードしない。

let _payload = null;

export async function loadVolatility() {
  try {
    const res = await fetch("./data/volatility.json", { cache: "no-cache" });
    if (res.ok) {
      const data = await res.json();
      if (data && data.sigma && typeof data.sigma === "object") _payload = data;
    }
  } catch (e) {
    // 取得できなくても致命的ではない（利確目標列が出ないだけ）
    console.warn("volatility.json の読み込みに失敗:", e);
  }
  return _payload;
}

export function getVolatility() {
  return _payload;
}

// payload から利確幅パラメータを取り出す（欠損時は TBK-0010 の既定にフォールバック）。
export function paramsFromPayload(payload) {
  const p = payload || {};
  return {
    k: Number.isFinite(p.k) ? p.k : 2.0,
    floor: Number.isFinite(p.floor) ? p.floor : 0.05,
    cap: Number.isFinite(p.cap) ? p.cap : 0.15,
  };
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

// 利確幅 = min(cap, max(floor, k × σ20))。σが無効なら null。
export function targetWidth(sigma, params) {
  if (!Number.isFinite(sigma) || sigma < 0) return null;
  const { k, floor, cap } = params;
  return clamp(k * sigma, floor, cap);
}

// 1保有ぶんの利確目標を組み立てる純粋関数（テスト対象）。
//   avgCost      平均取得単価（>0）
//   currentPrice 現在値（終値 or 場中・表示用。欠損時 null/NaN 可）
//   sigma        その銘柄の σ20（無ければ null）
//   resistances  抵抗線の価格配列（TBK-0016・省略可）。取得単価より上の最寄り抵抗線が
//                σ目標より近ければ、そちらを目標に採用する（min 方式）。
// 返り値: 利確目標が出せない（σ欠損・取得単価不正）場合は null。
//   { width, targetPrice, dist, hit, basis }
//   dist  = (targetPrice − currentPrice) / currentPrice（正 = あと dist で到達）。価格欠損時 null。
//   hit   = currentPrice ≥ targetPrice（到達済み）。価格欠損時 false。
//   basis = "sigma"（σ連動） | "resistance"（抵抗線連動）。どちらが目標を決めたか。
export function computeSellTarget(avgCost, currentPrice, sigma, params, resistances = null) {
  const width = targetWidth(sigma, params);
  if (width === null || !Number.isFinite(avgCost) || avgCost <= 0) return null;
  let targetPrice = avgCost * (1 + width);
  let basis = "sigma";
  if (Array.isArray(resistances)) {
    // 取得単価より上の抵抗線のみが利確候補（下の水準で売るのは利確ではない）
    const cands = resistances.map(Number).filter((r) => Number.isFinite(r) && r > avgCost);
    if (cands.length) {
      const nearest = Math.min(...cands);
      if (nearest < targetPrice) {
        targetPrice = nearest;
        basis = "resistance";
      }
    }
  }
  const hasPrice = Number.isFinite(currentPrice) && currentPrice > 0;
  return {
    width,
    targetPrice,
    dist: hasPrice ? targetPrice / currentPrice - 1 : null,
    hit: hasPrice ? currentPrice >= targetPrice : false,
    basis,
  };
}
