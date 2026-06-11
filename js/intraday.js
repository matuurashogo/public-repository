// 場中価格（intraday_prices.json・TBK-0008）の取得と鮮度判定。
// 表示専用: 含み損益と現在値の表示にだけ使い、判定（買いレベルの hit 等）には使わない。
// データの正は orphan ブランチ `intraday`（GitHub Actions が場中15分ごとに更新）。

const INTRADAY_URL =
  "https://raw.githubusercontent.com/matuurashogo/public-repository/intraday/data/intraday_prices.json";

// これより古い asOf は「場中データなし」とみなし、終値表示へフォールバックする（TBK-0008）
export const MAX_AGE_MIN = 90;

let _payload = null;

export async function loadIntradayPrices() {
  try {
    const res = await fetch(INTRADAY_URL, { cache: "no-cache" });
    if (res.ok) {
      const data = await res.json();
      if (data && data.prices && typeof data.prices === "object") _payload = data;
    }
  } catch (e) {
    // 取得できなくても致命的ではない（終値表示のまま）
    console.warn("intraday_prices.json の読み込みに失敗:", e);
  }
  return _payload;
}

// asOf（ISO 8601・+09:00）から「13:30」形式の時点ラベルを作る。
export function asOfLabel(asOfIso) {
  const s = String(asOfIso || "");
  return s.length >= 16 ? s.slice(11, 16) : "";
}

// 鮮度判定つきで場中データを返す純粋関数（テスト対象）。
// 新鮮なら { prices, label } を、古い・壊れている場合は null を返す（= 終値フォールバック）。
export function pickFresh(payload, nowMs, maxAgeMin = MAX_AGE_MIN) {
  if (!payload || !payload.asOf || !payload.prices) return null;
  const t = Date.parse(payload.asOf);
  if (!Number.isFinite(t)) return null;
  const ageMs = nowMs - t;
  if (ageMs > maxAgeMin * 60_000) return null; // 古い（夜間・ソース停止など）
  if (ageMs < -10 * 60_000) return null; // 未来すぎる asOf は壊れたデータとみなす
  return { prices: payload.prices, label: asOfLabel(payload.asOf) };
}

// アプリから使う入口。新鮮な場中データが無ければ null（呼び手は終値のまま描画する）。
export function freshIntraday(nowMs = Date.now()) {
  return pickFresh(_payload, nowMs);
}
