// マスターデータの状態管理 + localStorage 読み取りキャッシュ
// 正(source of truth)は Google Drive 上のマスターJSON。ここはメモリ状態とキャッシュを扱う。

const CACHE_KEY = "tradebook_cache_v1";
const MASTER_VERSION = 2;

function emptyMaster() {
  return { version: MASTER_VERSION, trades: [], deletedIds: {} };
}

// 簡易UUID（crypto.randomUUID が無い環境のフォールバック付き）
export function genId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// 取引に既定値（口座=特定 / 手数料0 / updatedAt）を補う。既存値は尊重する。
function normalizeTrade(t) {
  return {
    account: "特定",
    fee: 0,
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
  };
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

  return { version: MASTER_VERSION, trades, deletedIds };
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
