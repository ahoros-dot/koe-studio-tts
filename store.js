/* 保存まわり
   - 設定・下書き・読み辞書: localStorage の koe-studio.v1
   - API キー: localStorage か sessionStorage の koe-studio.key（「タブを閉じたら忘れる」なら sessionStorage）。書き出すデータには含めない
   - 履歴と声のお試し音声: IndexedDB（音声の Blob を入れるので localStorage では足りない）
   プライベートウィンドウなどで保存先が使えないこともあるので、読み書きはすべて try/catch で包み、使えなくても画面は動くようにする。 */

const STATE_KEY = "koe-studio.v1";
const KEY_KEY = "koe-studio.key";

export function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) || "null");
  } catch {
    return null;
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearState() {
  try { localStorage.removeItem(STATE_KEY); } catch { /* 使えなければ何もしない */ }
}

export function getKey() {
  try {
    return sessionStorage.getItem(KEY_KEY) || localStorage.getItem(KEY_KEY) || "";
  } catch {
    return "";
  }
}

// mode: "local"（この端末に保存）| "session"（タブを閉じたら忘れる）
export function setKey(key, mode) {
  clearKey();
  try {
    (mode === "session" ? sessionStorage : localStorage).setItem(KEY_KEY, key);
    return true;
  } catch {
    return false;
  }
}

export function clearKey() {
  try { localStorage.removeItem(KEY_KEY); } catch { /* 同上 */ }
  try { sessionStorage.removeItem(KEY_KEY); } catch { /* 同上 */ }
}

// ---- IndexedDB ----
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB が使えません"));
      const req = indexedDB.open("koe-studio", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        const h = d.createObjectStore("history", { keyPath: "id" });
        h.createIndex("createdAt", "createdAt");
        d.createObjectStore("samples", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        const r = fn(s);
        if (r) r.onsuccess = () => { out = r.result; };
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error("保存を中断しました"));
      })
  );
}

// entry: { id, createdAt, kind: "generate"|"compare", model, mode, voice?, speakers?, parts, sec, rawDb, wav: Blob }
export const addHistory = (entry) => tx("history", "readwrite", (s) => s.put(entry));
export const getHistory = (id) => tx("history", "readonly", (s) => s.get(id));
export const deleteHistory = (id) => tx("history", "readwrite", (s) => s.delete(id));
export const clearHistory = () => tx("history", "readwrite", (s) => s.clear());
export function listHistory() {
  // 一覧には音声の Blob を含めない（量が多いと重いので、再生や書き出しのときに getHistory で取り直す）
  return tx("history", "readonly", (s) => s.getAll()).then((all) =>
    (all || []).map(({ wav, ...rest }) => ({ ...rest, bytes: wav ? wav.size : 0 })).sort((a, b) => b.createdAt - a.createdAt)
  );
}

// 自分で作った声のお試し音声（voices.list は sample_audio を返さないので、作ったときの音声をここに残す）
export const putSample = (id, wav) => tx("samples", "readwrite", (s) => s.put({ id, wav }));
export const getSample = (id) => tx("samples", "readonly", (s) => s.get(id)).then((r) => (r ? r.wav : null));
export const deleteSample = (id) => tx("samples", "readwrite", (s) => s.delete(id));

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch { /* 使えない環境では出さない */ }
  return null;
}
