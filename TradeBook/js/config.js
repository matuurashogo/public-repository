// アプリ設定。利用開始前に CLIENT_ID をあなた自身の値に書き換えてください。
// 取得手順は README.md「初期セットアップ」を参照。
export const CONFIG = {
  // Google Cloud で発行した OAuth 2.0 クライアントID（ウェブアプリケーション）
  GOOGLE_CLIENT_ID: "611264947646-o65h7kftsbcqu8hcrilemfpa42in0gk1.apps.googleusercontent.com",

  // Drive上のマスターファイル名（通常変更不要）
  MASTER_FILENAME: "TradeBook_master.json",
};

// 松井証券のボックスレート（現物・1日の約定代金合計で決まる定額／税込）。
// 改定があった場合はこの表だけを書き換えれば計算に反映されます。
//   〜freeUntil 円: 0円 / それ超は stepAmount 円ごとに stepFee 円 / 上限 capFee 円
//   参考: https://www.matsui.co.jp/stock/domestic/fee/
export const MATSUI_BOX_RATE = {
  freeUntil: 500000, // 〜50万円は0円
  stepAmount: 1000000, // 100万円ごとの刻み
  stepFee: 1100, // 1段あたり1,100円
  capFee: 110000, // 上限110,000円
};
