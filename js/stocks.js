// 銘柄コード→銘柄名の解決（同梱の data/stocks.json を参照）
// API不要・オフライン可。未登録コードは空文字を返す。

let _map = {};
let _entries = []; // 検索用に展開した [{ code, name }] の配列

export async function loadStocks() {
  try {
    const res = await fetch("./data/stocks.json", { cache: "force-cache" });
    if (res.ok) {
      _map = await res.json();
    }
  } catch (e) {
    // オフライン等で取得できなくても致命的ではない（名前が出ないだけ）
    console.warn("stocks.json の読み込みに失敗:", e);
  }
  _entries = Object.entries(_map).map(([code, name]) => ({ code, name }));
  return _map;
}

export function codeToName(code) {
  return _map[String(code)] || "";
}

// 銘柄をコード/社名であいまい検索する。
// 数字クエリはコード前方一致、文字クエリは社名一致を優先し、
// 前方一致 → 部分一致の順で並べて上位 limit 件を返す。
// 戻り値: [{ code, name }]
export function searchStocks(query, limit = 8) {
  const q = String(query || "").trim();
  if (!q) return [];
  const qLower = q.toLowerCase();
  const isNum = /^\d+$/.test(q);

  const prefix = [];
  const partial = [];
  for (const e of _entries) {
    if (isNum) {
      if (e.code.startsWith(q)) prefix.push(e);
      else if (e.name && e.name.includes(q)) partial.push(e);
    } else {
      const name = e.name ? e.name.toLowerCase() : "";
      if (name.startsWith(qLower)) prefix.push(e);
      else if (name.includes(qLower)) partial.push(e);
    }
  }
  return [...prefix, ...partial].slice(0, limit);
}
