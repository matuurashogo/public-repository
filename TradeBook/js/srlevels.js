// 支持線・抵抗線（TBK-0014）: data/sr_levels.json を読み、保有銘柄カードと買い時ボードに
// 「現在値に最も近い支持線 / 抵抗線」を表示する。
// データの正は QDP R2 の調整後四本値（tools/gen_sr_levels.py が日次生成して同梱）。
// 本モジュールは JSON を表示するだけで、水準の再計算はしない（契約は TBK-0014）。

let _payload = null;

export async function loadSrLevels() {
  try {
    const res = await fetch("./data/sr_levels.json", { cache: "no-cache" });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.stocks)) _payload = data;
    }
  } catch (e) {
    // 未配信・取得失敗でも致命的ではない（支持線・抵抗線の表示が出ないだけ）
    console.warn("sr_levels.json の読み込みに失敗:", e);
  }
  return _payload;
}

export function getSrLevels() {
  return _payload;
}

// code4 → { close, support: [...], resistance: [...] }。無ければ null。
export function srForCode(payload, code) {
  if (!payload || !Array.isArray(payload.stocks)) return null;
  const s = payload.stocks.find((x) => x.code === String(code));
  if (!s) return null;
  return s;
}

// 現在値に最も近い支持線・抵抗線と距離を返す純粋関数（テスト対象）。
// currentPrice を渡すと配信時の close ではなくその価格を基準に振り分け直す
// （場中価格が水準を跨いだ場合も表示が正しくなる）。価格が無い場合は close 基準。
// 戻り値: { support: {price, dist} | null, resistance: {price, dist} | null }
//   dist = (水準 − 基準価格) / 基準価格（支持は負・抵抗は正）。
export function nearestSr(sr, currentPrice = null) {
  if (!sr) return { support: null, resistance: null };
  const base = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : Number(sr.close);
  if (!Number.isFinite(base) || base <= 0) return { support: null, resistance: null };

  const all = [...(sr.support || []), ...(sr.resistance || [])]
    .map(Number)
    .filter((v) => Number.isFinite(v) && v > 0);
  let sup = null;
  let res = null;
  for (const v of all) {
    if (v < base && (sup === null || v > sup)) sup = v;
    if (v > base && (res === null || v < res)) res = v;
  }
  return {
    support: sup === null ? null : { price: sup, dist: (sup - base) / base },
    resistance: res === null ? null : { price: res, dist: (res - base) / base },
  };
}

// 距離の表示文字列（例 "-3.2%" / "+4.1%"）。
export function fmtSrDist(dist) {
  if (!Number.isFinite(dist)) return "";
  const pct = dist * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}
