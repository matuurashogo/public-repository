// マスターデータの状態管理 + localStorage 読み取りキャッシュ
// 正(source of truth)は Google Drive 上のマスターJSON。ここはメモリ状態とキャッシュを扱う。

const CACHE_KEY = "tradebook_cache_v1";
const MASTER_VERSION = 3;

// タグ候補の初期値（seed）。ユーザーはアプリ上で追加できる（既存値は尊重・上書きしない）。
export const SEED_ENTRY_TAGS = [
  "25日線タッチ",
  "深押し（節目）",
  "高ボラ急落リバウンド",
  "ブレイク後の押し目",
  "出来高急増の反発",
  "決算・材料",
  "なんとなく（裁量）",
];
export const SEED_EXIT_TAGS = [
  "利確（目標到達）",
  "利確（急騰で伸びた）",
  "損切り（ルール通り）",
  "損切り（耐えきれず）",
  "時間切れ・見切り",
  "地合い悪化で回避",
];

function emptyMaster() {
  return {
    version: MASTER_VERSION,
    trades: [],
    deletedIds: {},
    entryTags: [...SEED_ENTRY_TAGS],
    exitTags: [...SEED_EXIT_TAGS],
  };
}

// 文字列配列を重複・空白除去しつつ順序を保って正規化する。
function normalizeTagList(list, seed) {
  if (!Array.isArray(list)) return [...seed];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw).trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out.length > 0 ? out : [...seed];
}

// 簡易UUID（crypto.randomUUID が無い環境のフォールバック付き）
export function genId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// 取引に既定値（口座=特定 / 手数料0 / タグ・メモ=null / updatedAt）を補う。既存値は尊重する。
function normalizeTrade(t) {
  return {
    account: "特定",
    fee: 0,
    entryTag: null, // 買いのエントリー根拠タグ
    entryNote: null, // 買いの自由メモ
    exitTag: null, // 売りの手仕舞い根拠タグ
    exitNote: null, // 売りの自由メモ
    updatedAt: 0, // 旧データ（version1）は0扱い。新しい編集ほど大きい値になる
    ...t,
  };
}

// 旧バージョンや欠損フィールドを補正したマスターを返す（破壊しない）。
function normalizeMaster(master) {
  if (!master || !Array.isArray(master.trades)) return emptyMaster();
  return {
    version: MASTER_VERSION,
    trades: master.trades.map(normalizeTrade),
    deletedIds: master.deletedIds && typeof master.deletedIds === "object" ? { ...master.deletedIds } : {},
    entryTags: normalizeTagList(master.entryTags, SEED_ENTRY_TAGS),
    exitTags: normalizeTagList(master.exitTags, SEED_EXIT_TAGS),
  };
}

// 2つのタグ配列を順序を保って和集合にする（端末ごとに追加したタグを失わない）。
function unionTags(a, b) {
  const out = [];
  const seen = new Set();
  for (const tag of [...(a || []), ...(b || [])]) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

// ローカルとリモートのマスターを取引id単位でマージする（純粋関数・テスト対象）。
//  - 同一idは updatedAt が新しい方を採用（last-write-wins per record）
//  - 削除は tombstone(deletedIds: id->削除時刻) で表現し、復活を防ぐ
//  - tombstone より新しい updatedAt を持つ取引は「削除後に再編集」とみなし生存させる
export function mergeMasters(localMaster, remoteMaster) {
  const a = normalizeMaster(localMaster);
  const b = normalizeMaster(remoteMaster);

  // tombstone を統合（同一idは新しい削除時刻を採用）
  const deletedIds = { ...a.deletedIds };
  for (const [id, ts] of Object.entries(b.deletedIds)) {
    deletedIds[id] = Math.max(deletedIds[id] || 0, ts);
  }

  // 取引を id 単位で新しい方に寄せる
  const byId = new Map();
  for (const t of [...a.trades, ...b.trades]) {
    const cur = byId.get(t.id);
    if (!cur || (t.updatedAt || 0) > (cur.updatedAt || 0)) byId.set(t.id, t);
  }

  // tombstone より古い（=削除後に編集されていない）取引は除外
  const trades = [];
  for (const t of byId.values()) {
    const delTs = deletedIds[t.id];
    if (delTs !== undefined && delTs >= (t.updatedAt || 0)) continue; // 削除が有効
    trades.push(t);
  }

  // 生存している取引の tombstone は不要なので掃除する
  for (const t of trades) delete deletedIds[t.id];

  // タグ候補は端末ごとに増えうるため和集合で統合する（消失を防ぐ）
  const entryTags = unionTags(a.entryTags, b.entryTags);
  const exitTags = unionTags(a.exitTags, b.exitTags);

  return { version: MASTER_VERSION, trades, deletedIds, entryTags, exitTags };
}

export class Store {
  constructor() {
    this.master = emptyMaster();
  }

  // ---- マスター全体 ----
  setMaster(master) {
    this.master = normalizeMaster(master);
    this._writeCache();
    return this.master;
  }

  getMaster() {
    return this.master;
  }

  getTrades() {
    return this.master.trades;
  }

  // ---- 取引の追加・編集・削除 ----
  addTrade(trade) {
    const t = normalizeTrade({ id: genId(), ...trade });
    t.updatedAt = Date.now();
    this.master.trades.push(t);
    this._writeCache();
    return t;
  }

  updateTrade(id, patch) {
    const idx = this.master.trades.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    this.master.trades[idx] = { ...this.master.trades[idx], ...patch, id, updatedAt: Date.now() };
    this._writeCache();
    return this.master.trades[idx];
  }

  // ---- タグ候補の追加（重複・空は無視。trim 済みを採用）----
  addEntryTag(tag) {
    return this._addTag("entryTags", tag);
  }

  addExitTag(tag) {
    return this._addTag("exitTags", tag);
  }

  _addTag(field, tag) {
    const t = String(tag || "").trim();
    if (!t) return false;
    if (!Array.isArray(this.master[field])) this.master[field] = [];
    if (this.master[field].includes(t)) return false;
    this.master[field].push(t);
    this._writeCache();
    return true;
  }

  // ---- タグの改名・削除（kind: "entry" | "exit"）----
  // 改名は候補リストと既存取引のタグを同時に更新する（updatedAtを進めて同期に乗せる）。
  renameTag(kind, oldName, newName) {
    const field = kind === "exit" ? "exitTags" : "entryTags";
    const tagField = kind === "exit" ? "exitTag" : "entryTag";
    const from = String(oldName);
    const to = String(newName || "").trim();
    if (!to || from === to) return false;
    const list = this.master[field];
    if (!Array.isArray(list)) return false;
    const idx = list.indexOf(from);
    if (idx === -1) return false;
    // 改名先が既存なら重複を作らず統合する
    if (list.includes(to)) list.splice(idx, 1);
    else list[idx] = to;
    for (const t of this.master.trades) {
      if (t[tagField] === from) {
        t[tagField] = to;
        t.updatedAt = Date.now();
      }
    }
    this._writeCache();
    return true;
  }

  // 削除は候補リストから外すのみ（既存取引のタグ値は破壊せず残す＝履歴・集計は維持）。
  deleteTag(kind, name) {
    const field = kind === "exit" ? "exitTags" : "entryTags";
    const list = this.master[field];
    if (!Array.isArray(list)) return false;
    const idx = list.indexOf(String(name));
    if (idx === -1) return false;
    list.splice(idx, 1);
    this._writeCache();
    return true;
  }

  deleteTrade(id) {
    const before = this.master.trades.length;
    this.master.trades = this.master.trades.filter((t) => t.id !== id);
    const removed = this.master.trades.length < before;
    if (removed) {
      // 他端末で復活しないよう tombstone を残す
      if (!this.master.deletedIds) this.master.deletedIds = {};
      this.master.deletedIds[id] = Date.now();
    }
    this._writeCache();
    return removed;
  }

  // ---- localStorage キャッシュ（あくまで読み取り用。正はDrive）----
  _writeCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(this.master));
    } catch (e) {
      console.warn("キャッシュ保存に失敗:", e);
    }
  }

  loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        this.master = normalizeMaster(JSON.parse(raw));
        return true;
      }
    } catch (e) {
      console.warn("キャッシュ読み込みに失敗:", e);
    }
    return false;
  }
}
