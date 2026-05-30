// Google Drive 連携（OAuth 2.0 トークンフロー + Drive REST API）
// スコープ drive.file: アプリが作成したファイルのみアクセス可能。
// Google Identity Services (GIS) の gsi/client は index.html で読み込む。

import { CONFIG } from "./config.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";

let _tokenClient = null;
let _accessToken = null;
let _fileId = null; // マスターファイルのDrive上のID（判明後にキャッシュ）

// 設定済みか（プレースホルダのままでないか）
export function isConfigured() {
  return (
    CONFIG.GOOGLE_CLIENT_ID &&
    !CONFIG.GOOGLE_CLIENT_ID.startsWith("PASTE_")
  );
}

export function isSignedIn() {
  return !!_accessToken;
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
        _accessToken = resp.access_token;
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

function authHeaders() {
  return { Authorization: `Bearer ${_accessToken}` };
}

// マスターファイルのIDを検索（無ければ null）
async function findMasterFileId() {
  const q = encodeURIComponent(
    `name='${CONFIG.MASTER_FILENAME}' and trashed=false`
  );
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Drive検索に失敗: ${res.status}`);
  const data = await res.json();
  if (data.files && data.files.length > 0) {
    _fileId = data.files[0].id;
    return _fileId;
  }
  return null;
}

// マスターを読み込む。無ければ null を返す（呼び出し側で空マスターを使う）
export async function loadMaster() {
  if (!_accessToken) throw new Error("未サインインです。");
  const id = await findMasterFileId();
  if (!id) return null;
  const url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`マスター読込に失敗: ${res.status}`);
  return await res.json();
}

// マスターを書き戻す（全体上書き）。初回はファイルを新規作成する。
export async function saveMaster(master) {
  if (!_accessToken) throw new Error("未サインインです。");
  const body = JSON.stringify(master);

  if (_fileId) {
    // 既存ファイルを更新（media のみ）
    const url = `https://www.googleapis.com/upload/drive/v3/files/${_fileId}?uploadType=media`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error(`マスター更新に失敗: ${res.status}`);
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
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: multipart,
  });
  if (!res.ok) throw new Error(`マスター作成に失敗: ${res.status}`);
  const data = await res.json();
  _fileId = data.id;
}
