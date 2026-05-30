// マスターデータの状態管理 + localStorage 読み取りキャッシュ
// 正(source of truth)は Google Drive 上のマスターJSON。ここはメモリ状態とキャッシュを扱う。

const CACHE_KEY = "tradebook_cache_v1";
const MASTER_VERSION = 1;

function emptyMaster() {
  return { version: MASTER_VERSION, trades: [] };
}

// 簡易UUID（crypto.randomUUID が無い環境のフォールバック付き）
export function genId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export class Store {
  constructor() {
    this.master = emptyMaster();
  }

  // ---- マスター全体 ----
  setMaster(master) {
    if (!master || !Array.isArray(master.trades)) {
      this.master = emptyMaster();
    } else {
      this.master = { version: master.version || MASTER_VERSION, trades: master.trades };
    }
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
    const t = { id: genId(), ...trade };
    this.master.trades.push(t);
    this._writeCache();
    return t;
  }

  updateTrade(id, patch) {
    const idx = this.master.trades.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    this.master.trades[idx] = { ...this.master.trades[idx], ...patch, id };
    this._writeCache();
    return this.master.trades[idx];
  }

  deleteTrade(id) {
    const before = this.master.trades.length;
    this.master.trades = this.master.trades.filter((t) => t.id !== id);
    this._writeCache();
    return this.master.trades.length < before;
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
        this.master = JSON.parse(raw);
        return true;
      }
    } catch (e) {
      console.warn("キャッシュ読み込みに失敗:", e);
    }
    return false;
  }
}
