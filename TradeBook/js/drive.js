// Google Drive 連携（OAuth 2.0 トークンフロー + Drive REST API）
// スコープ drive.file: アプリが作成したファイルのみアクセス可能。
// Google Identity Services (GIS) の gsi/client は index.html で読み込む。

import { CONFIG } from "./config.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_KEY = "tb_drive_token"; // localStorage: { access_token, expiry(ms) }

let _tokenClient = null;
let _accessToken = null;
let _tokenExpiry = 0; // アクセストークンの失効時刻(ms)。0なら未取得
let _fileId = null; // マスターファイルのDrive上のID（判明後にキャッシュ）
let _knownModifiedTime = null; // 最後に読み書きしたサーバ側の modifiedTime（衝突検出用）

// 設定済みか（プレースホルダのままでないか）
export function isConfigured() {
  return (
    CONFIG.GOOGLE_CLIENT_ID &&
    !CONFIG.GOOGLE_CLIENT_ID.startsWith("PASTE_")
  );
}

// 有効な（未失効の）アクセストークンを保持しているか
export function isSignedIn() {
  return !!_accessToken && _tokenExpiry > Date.now();
}

// 取得したトークンをメモリ + localStorage に保存する。
// expiresInSec は GIS が返す有効期間(秒)。60秒の安全マージンを引いて失効扱いにする。
function persistToken(token, expiresInSec) {
  _accessToken = token;
  const ttl = Number(expiresInSec) > 0 ? Number(expiresInSec) : 3000;
  _tokenExpiry = Date.now() + Math.max(0, ttl - 60) * 1000;
  try {
    localStorage.setItem(
      TOKEN_KEY,
      JSON.stringify({ access_token: token, expiry: _tokenExpiry })
    );
  } catch (_) {
    // ストレージ不可（プライベートモード等）でもメモリ上では当該セッション中は動作する
  }
}

// トークンを破棄する（失効検出時・サインアウト相当）。
function clearToken() {
  _accessToken = null;
  _tokenExpiry = 0;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (_) {
    /* noop */
  }
}

// localStorage に有効なトークンが残っていればメモリへ復元する。
// PWA をいったん閉じても、失効までは無操作で同期できるようにするための起動時フック。
export function restoreToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return false;
    const { access_token, expiry } = JSON.parse(raw);
    if (access_token && typeof expiry === "number" && expiry > Date.now()) {
      _accessToken = access_token;
      _tokenExpiry = expiry;
      return true;
    }
  } catch (_) {
    /* 壊れた値は破棄する */
  }
  clearToken();
  return false;
}

// GIS のトークンクライアントを初期化（gsi/client ロード後に呼ぶ）
function ensureTokenClient() {
  if (_tokenClient) return _tokenClient;
  if (typeof google === "undefined" || !google.accounts || !google.accounts.oauth2) {
    throw new Error("Google Identity Services が読み込まれていません。");
  }
  _tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: () => {}, // requestAccessToken 呼び出し時に上書きする
  });
  return _tokenClient;
}

// サインイン（アクセストークンを取得）
export function signIn() {
  return new Promise((resolve, reject) => {
    let client;
    try {
      client = ensureTokenClient();
    } catch (e) {
      reject(e);
      return;
    }
    client.callback = (resp) => {
      if (resp && resp.access_token) {
        persistToken(resp.access_token, resp.expires_in);
        resolve(_accessToken);
      } else {
        reject(new Error("アクセストークンを取得できませんでした。"));
      }
    };
    client.error_callback = (err) => reject(err);
    // 既存トークンがあれば再同意を省略（consent不要）
    client.requestAccessToken({ prompt: _accessToken ? "" : "consent" });
  });
}

// GIS ライブラリ(gsi/client)の読み込みを待つ。index.html で async 読み込みのため、
// 起動直後はまだ未ロードのことがある。
function whenGisReady(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (typeof google !== "undefined" && google.accounts && google.accounts.oauth2) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error("Google Identity Services の読み込みがタイムアウトしました。"));
      } else {
        setTimeout(poll, 50);
      }
    })();
  });
}

// サイレント再認証: 既存の同意があれば UI を出さずにアクセストークンを再取得する。
// 同意が必要 / セッションが無い / iOS のサードパーティ Cookie 制限などの場合は失敗し、
// 呼び出し側で手動サインインにフォールバックする想定。
export async function signInSilent(timeoutMs = 8000) {
  await whenGisReady();
  const client = ensureTokenClient();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error("サイレント認証がタイムアウトしました。")),
      timeoutMs
    );
    client.callback = (resp) => {
      if (resp && resp.access_token) {
        persistToken(resp.access_token, resp.expires_in);
        finish(resolve, _accessToken);
      } else {
        finish(reject, new Error("トークンを取得できませんでした。"));
      }
    };
    client.error_callback = (err) => finish(reject, err);
    // prompt:"" → 既存の許可があれば UI を出さずに再取得（要・追加同意なら error_callback）
    client.requestAccessToken({ prompt: "" });
  });
}

function authHeaders() {
  return { Authorization: `Bearer ${_accessToken}` };
}

// Drive REST 共通フェッチ。Authorization を付与し、401（トークン失効）が返ったら
// トークンを破棄してサイレント再認証を1回だけ試み、成功すれば同じリクエストを再送する。
// サイレント再認証が失敗した場合（iOSのITP等）はトークン未保持のまま応答を返すので、
// 呼び出し側で isSignedIn() を見て手動サインインへフォールバックする。
async function driveFetch(url, opts = {}) {
  const build = () => ({
    ...opts,
    headers: { ...(opts.headers || {}), ...authHeaders() },
  });
  let res = await fetch(url, build());
  if (res.status === 401) {
    clearToken();
    try {
      await signInSilent(5000);
    } catch (_) {
      /* 再認証不可。呼び出し側でハンドリングする */
    }
    if (_accessToken) {
      res = await fetch(url, build());
    }
  }
  return res;
}

// マスターファイルのIDを検索（無ければ null）。modifiedTime を更新日時として保持する。
// 同名ファイルが複数ある場合（split-brain）は最終更新が最も新しいものを採用する。
async function findMasterFileId() {
  const q = encodeURIComponent(
    `name='${CONFIG.MASTER_FILENAME}' and trashed=false`
  );
  const url =
    `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive` +
    `&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)`;
  const res = await driveFetch(url);
  if (!res.ok) throw new Error(`Drive検索に失敗: ${res.status}`);
  const data = await res.json();
  if (data.files && data.files.length > 0) {
    _fileId = data.files[0].id; // orderBy で先頭が最新
    _knownModifiedTime = data.files[0].modifiedTime || null;
    return _fileId;
  }
  return null;
}

// 現在のサーバ側 modifiedTime を取得する（保存前の衝突検出用）。
async function fetchModifiedTime(id) {
  const url = `https://www.googleapis.com/drive/v3/files/${id}?fields=modifiedTime`;
  const res = await driveFetch(url);
  if (!res.ok) throw new Error(`更新時刻の取得に失敗: ${res.status}`);
  const data = await res.json();
  return data.modifiedTime || null;
}

// マスターを読み込む。無ければ null を返す（呼び出し側で空マスターを使う）
export async function loadMaster() {
  if (!_accessToken) throw new Error("未サインインです。");
  const id = await findMasterFileId();
  if (!id) return null;
  const url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
  const res = await driveFetch(url);
  if (!res.ok) throw new Error(`マスター読込に失敗: ${res.status}`);
  return await res.json();
}

// 保存時にサーバ側が新しくなっていたら投げるエラー（呼び出し側でマージ＋再保存する）。
export class ConflictError extends Error {
  constructor(serverModifiedTime) {
    super("サーバ側のデータが更新されています（衝突）。");
    this.name = "ConflictError";
    this.code = "CONFLICT";
    this.serverModifiedTime = serverModifiedTime;
  }
}

// マスターを書き戻す（全体上書き）。初回はファイルを新規作成する。
// 既存ファイル更新時は、保存直前にサーバ側 modifiedTime を確認し、最後に読んだ時刻と
// 異なれば ConflictError を投げて上書きを止める（last-write-wins によるデータ消失防止）。
export async function saveMaster(master) {
  if (!_accessToken) throw new Error("未サインインです。");
  const body = JSON.stringify(master);

  if (_fileId) {
    // 衝突検出: 別端末がこの間に保存していないか確認
    if (_knownModifiedTime) {
      const current = await fetchModifiedTime(_fileId);
      if (current && current !== _knownModifiedTime) {
        throw new ConflictError(current);
      }
    }
    // 既存ファイルを更新（media）。更新後の modifiedTime を取得して保持する
    const url = `https://www.googleapis.com/upload/drive/v3/files/${_fileId}?uploadType=media&fields=id,modifiedTime`;
    const res = await driveFetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error(`マスター更新に失敗: ${res.status}`);
    const data = await res.json();
    _knownModifiedTime = data.modifiedTime || _knownModifiedTime;
    return;
  }

  // 新規作成（multipart: メタデータ + 本体）
  const boundary = "tradebook_boundary_" + Date.now();
  const metadata = { name: CONFIG.MASTER_FILENAME, mimeType: "application/json" };
  const multipart =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    "Content-Type: application/json\r\n\r\n" +
    body +
    `\r\n--${boundary}--`;

  const url =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime";
  const res = await driveFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: multipart,
  });
  if (!res.ok) throw new Error(`マスター作成に失敗: ${res.status}`);
  const data = await res.json();
  _fileId = data.id;
  _knownModifiedTime = data.modifiedTime || null;
}
