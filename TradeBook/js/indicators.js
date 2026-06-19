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

// 約定日ぶんの客観データが出揃ったか（最新営業日 latestDate が約定日 tradeDate に到達したか）。
// 純粋関数。当日日中（latestDate=前日）は false を返し、翌日以降に true になる。
export function isEntryDataReady(latestDate, tradeDate) {
  return !!latestDate && !!tradeDate && latestDate >= tradeDate;
}

// その銘柄の指標データに含まれる最新営業日(YYYY-MM-DD)。未取得・空なら null。
// j-quantsはEODデータのため、約定当日の日中はこの値が前日までになる。
// 「約定日ぶんが出揃ったか」（latest >= 約定日）の判定に使う＝当日日中の早すぎる凍結を防ぐ。
export function latestIndicatorDate(code) {
  const data = _cache[String(code)];
  if (!data || !Array.isArray(data.rows) || data.rows.length === 0) return null;
  return data.rows[data.rows.length - 1].d;
}

// 取得済みの指標行（昇順・各 {d, c, ...}）を返す。未取得・欠損は null。結果メトリクス計算用。
export function getRows(code) {
  const data = _cache[String(code)];
  return data && Array.isArray(data.rows) ? data.rows : null;
}

const _round4 = (x) => Math.round(x * 1e4) / 1e4;

// 約定後の結果メトリクスを終値系列(c)から計算する純粋関数（TBK-0005）。
//   rows: 昇順の指標行（各 {d, c, ...}）/ entryDate: 約定日 / cost: 約定単価 / horizon: 営業日数
// 戻り値: { cost, ret5, ret20, mfe, mae, asOf, horizon, complete } または null。
//   ret5/ret20 = +5/+20営業日後の終値リターン（無ければ null）
//   mfe/mae    = 起点〜+horizon営業日の最大含み益率 / 最大含み損率
//   complete   = horizon営業日ぶんの行が揃ったか（揃ったら凍結可能。未到達は暫定）
export function computeEntryOutcome(rows, entryDate, cost, horizon = 20) {
  if (!Array.isArray(rows) || rows.length === 0 || !(cost > 0)) return null;
  // 約定日の行（d <= entryDate を満たす最後）を二分探索で特定（lookupSnapshot と同じ起点）
  let lo = 0;
  let hi = rows.length - 1;
  let i0 = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].d <= entryDate) {
      i0 = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (i0 < 0 || typeof rows[i0].c !== "number") return null; // 期間前 or 旧スキーマ（終値なし）
  const end = Math.min(i0 + horizon, rows.length - 1);
  let maxC = -Infinity;
  let minC = Infinity;
  for (let i = i0; i <= end; i++) {
    const c = rows[i].c;
    if (typeof c !== "number") continue;
    if (c > maxC) maxC = c;
    if (c < minC) minC = c;
  }
  const ret = (n) => {
    const r = rows[i0 + n];
    return r && typeof r.c === "number" ? _round4((r.c - cost) / cost) : null;
  };
  return {
    cost,
    ret5: ret(5),
    ret20: ret(20),
    mfe: _round4((maxC - cost) / cost),
    mae: _round4((minC - cost) / cost),
    asOf: rows[end].d,
    horizon,
    complete: i0 + horizon <= rows.length - 1,
  };
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
