// 銘柄コード→銘柄名の解決（同梱の data/stocks.json を参照）
// API不要・オフライン可。未登録コードは空文字を返す。

let _map = {};

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
  return _map;
}

export function codeToName(code) {
  return _map[String(code)] || "";
}
