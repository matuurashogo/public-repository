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
export function parseTradeText(text) {
  if (!text || !String(text).trim()) return null;
  const t = String(text).replace(/[　\t]/g, " ");

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
    // フォールバック: 年(19xx/20xx)・数量・価格を除いた最初の4桁トークン。
    const used = new Set([quantity, price].filter((x) => x != null));
    const cands = (t.match(/\b(?:[0-9]{3}[0-9A-Z]|[0-9]{4})\b/g) || []).filter(
      (c) => !/^(19|20)\d{2}$/.test(c) && !used.has(toNum(c))
    );
    code = cands[0] || null;
  }

  const parsed = { date, code, side, quantity, price, account };
  if (Object.values(parsed).every((v) => v == null)) return null;
  return parsed;
}
