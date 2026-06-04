// エントリー・スナップショットの遅延取得と引き当て。
// data/indicators/<code>.json（監視リスト銘柄・直近約2年）を必要な銘柄だけ取りに行き、
// 買い日付時点の客観指標（dev=25日線乖離 / abv=75日線上か / vol=出来高20日平均比）を返す。
// データの正は jquants-data（GitHub Actions が日次生成して同梱）。

const _cache = {}; // code -> payload(object) | null（取得完了後のみ設定。null = 監視リスト外/欠損）
const _inflight = {}; // code -> Promise（取得中。完了まで _cache には入れない）

// 指定コード群の指標を必要分だけ先読みする（重複は1回だけ）。
export async function prefetchIndicators(codes) {
  const uniq = [...new Set((codes || []).map(String))];
  await Promise.all(uniq.map(loadIndicator));
}

// 単一コードの指標を取得（メモリキャッシュ優先・ネットワークは1回だけ）。
export async function loadIndicator(code) {
  code = String(code);
  if (code in _cache) return _cache[code];
  if (code in _inflight) return _inflight[code];
  const p = (async () => {
    let result = null;
    try {
      const res = await fetch(`./data/indicators/${code}.json`, { cache: "no-cache" });
      if (res.ok) {
        const data = await res.json();
        result = data && Array.isArray(data.rows) ? data : null;
      }
    } catch (e) {
      // 取得できなくても致命的ではない（客観スナップショットが出ないだけ）
      console.warn(`indicators/${code}.json の読み込みに失敗:`, e);
    }
    _cache[code] = result; // 取得完了時のみ確定（in-flight 中は status=unknown）
    delete _inflight[code];
    return result;
  })();
  _inflight[code] = p;
  return p;
}

// 取得状態: "ok"（データあり）/ "missing"（取得済みだが監視リスト外・欠損）/ "unknown"（未取得・取得中）。
export function indicatorStatus(code) {
  code = String(code);
  if (!(code in _cache)) return "unknown";
  return _cache[code] ? "ok" : "missing";
}

// d 昇順の rows から d <= date を満たす最後の行を二分探索して返す純粋関数（テスト対象）。
// 約定日が休場でも直近の営業日(<=date)へフォールバックする。期間より前は null。
export function lookupSnapshot(rows, date) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let lo = 0;
  let hi = rows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].d <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans < 0) return null; // 期間より前（上場前など）
  const r = rows[ans];
  return { dev: r.dev, abv: r.abv, vol: r.vol, rsi: r.rsi, hv: r.hv, date: r.d };
}

// 買い日付(YYYY-MM-DD)時点のスナップショットを返す。
// 戻り値: { dev, abv, vol, date } または null（監視リスト外・データ未取得・期間外）。
export function getSnapshot(code, date) {
  const data = _cache[String(code)];
  if (!data) return null;
  return lookupSnapshot(data.rows, date);
}

// スナップショットを客観軸のバケット名へ写像する（純粋）。閾値は設計の叩き台。
//   axis: "dip"（凹みの深さ）/ "vol"（出来高急増）/ "trend"（トレンド位置）
//         "rsi"（売られすぎ度）/ "hv"（年率ボラティリティ）
export function bucketOf(axis, snap) {
  if (!snap) return null;
  if (axis === "dip") {
    if (snap.dev <= -0.07) return "深い押し（≤-7%）";
    if (snap.dev <= -0.03) return "中くらい（-3〜-7%）";
    return "浅い/順張り（>-3%）";
  }
  if (axis === "vol") {
    return snap.vol >= 1.5 ? "出来高急増（≥1.5倍）" : "通常出来高（<1.5倍）";
  }
  if (axis === "trend") {
    return snap.abv ? "上昇トレンド（75日線上）" : "下降局面（75日線下）";
  }
  if (axis === "rsi") {
    if (snap.rsi == null) return null;
    if (snap.rsi <= 30) return "売られすぎ（≤30）";
    if (snap.rsi <= 50) return "中立（30〜50）";
    return "強め（>50）";
  }
  if (axis === "hv") {
    if (snap.hv == null) return null;
    if (snap.hv < 0.2) return "低ボラ（<20%）";
    if (snap.hv < 0.4) return "中ボラ（20〜40%）";
    return "高ボラ（≥40%）";
  }
  return null;
}
