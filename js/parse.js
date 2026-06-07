// 松井証券「約定詳細」などからコピーしたテキストを解析し、取引フォームへ流し込む。
// iOSのLive Text等で画面の文字を選択コピー→貼り付けた文字列を想定。
// 拾えなかった項目は null（フォーム側で手入力にフォールバックする）。

function toNum(s) {
  if (s == null) return null;
  const n = Number(String(s).replace(/[,，\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ラベルの直後に現れる「YYYY/MM/DD（区切りは / - . 年月日）」を YYYY-MM-DD で返す。
function findDate(t, label) {
  const re = new RegExp(label + "[^0-9]{0,8}(\\d{4})[\\/\\-年.](\\d{1,2})[\\/\\-月.](\\d{1,2})");
  const m = t.match(re);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

// 約定テキストを解析して { date, code, side, quantity, price, account } を返す。
// すべて null のときは null を返す。
// OCR/全角ゆれを読める形に正規化する（表示にも使う）。
//  1) NFKC: 丸数字 ①→1 / ⑳→20、全角英数→半角 に変換
//  2) 3桁区切りの . , を畳む（749.000 / 7,490 → 749000 / 7490。OCRは , を . と誤読しがち）
// ※文字間の空白除去はパース時のみ行う（表示は空白を残して読みやすくする）。
export function normalizeOcrText(text) {
  let t = String(text).normalize("NFKC");
  t = t.replace(/(\d)[.,，](?=\d{3}(?!\d))/g, "$1");
  return t;
}

export function parseTradeText(text) {
  if (!text || !String(text).trim()) return null;
  // 正規化したうえで、ラベル照合のため文字間の水平空白を除去（改行は保持）。
  const t = normalizeOcrText(text).replace(/[^\S\n]+/g, "");

  // 日付: 約定日を最優先。無ければ受付日時/受渡日。
  const date = findDate(t, "約定日") || findDate(t, "受付日時") || findDate(t, "受渡日");

  // 売買: 取引区分（現物買/現物売）。買付/売却/買/売も許容。
  let side = null;
  const sm = t.match(/取引区分[^買売現]{0,6}((?:現物)?[買売]|買付|売却)/);
  if (sm) side = sm[1].includes("買") ? "買" : "売";

  // 口座: 特定/一般→特定（課税）、NISA/つみたて/成長投資→NISA。
  let account = null;
  const ac = t.match(/口座区分[\s\S]{0,10}?(NISA|ＮＩＳＡ|つみたて|成長投資|特定|一般)/);
  if (ac) account = /NISA|ＮＩＳＡ|つみたて|成長投資/.test(ac[1]) ? "NISA" : "特定";

  // 数量: 約定数を最優先、無ければ発注数。
  const qm = t.match(/約定数[^\d]{0,8}([\d,，]+)/) || t.match(/発注数[^\d]{0,8}([\d,，]+)/);
  const quantity = qm ? toNum(qm[1]) : null;

  // 単価: 約定代金 ÷ 約定数 が最も正確（平均約定単価）。無ければ 約定単価/値段。
  let price = null;
  const amt = (t.match(/約定代金[^\d]{0,8}([\d,，]+)/) || [])[1];
  if (amt && quantity) price = Math.round(toNum(amt) / quantity);
  if (price == null) {
    const pm = t.match(/約定単価[^\d]{0,8}([\d,，]+)/) || t.match(/値段[^\d]{0,8}([\d,，]+)/);
    price = pm ? toNum(pm[1]) : null;
  }

  // コード: 市場名（東証/名証等）の直前にある4桁(英数)を最優先。
  let code = null;
  const cm = t.match(
    /([0-9]{3}[0-9A-Z]|[0-9]{4})\s*(?:東証|名証|福証|札証|東P|東S|東G|プライム|スタンダード|グロース)/
  );
  if (cm) code = cm[1];
  if (!code) {
    // フォールバック: 日付/時刻/価格などのノイズを避けるため文脈で限定。
    // 直前が数字や区切り( / : . - ー )でなく、直後が数字や 円 % : / . でない4桁のみ採用。
    // 年(19xx/20xx)・数量・価格と一致するものは除外。誤検出するくらいなら null にする。
    const used = new Set([quantity, price].filter((x) => x != null));
    const re = /(?:^|[^\d/:.\-ー])((?:[0-9]{3}[0-9A-Z]|[0-9]{4}))(?![\d円%:/.])/g;
    let m;
    while ((m = re.exec(t))) {
      const c = m[1];
      if (/^(19|20)\d{2}$/.test(c)) continue;
      if (used.has(toNum(c))) continue;
      code = c;
      break;
    }
  }

  const parsed = { date, code, side, quantity, price, account };
  if (Object.values(parsed).every((v) => v == null)) return null;
  return parsed;
}
