/**
 * IndexedDB 里缓存由口令派生的 CryptoKey（extractable=false，JS 读不出密钥材料）。
 * 用途：同一设备上第二次打开页面无需再次输入口令。
 * 诚实边界：密钥可被"使用"——若页面被注入恶意脚本，仍可调用 decrypt 读取数据，
 * 所以这是便利性缓存，不是 XSS 防线。服务端零知识不受影响。
 */

const DB_NAME = "vault-poc-keys";
const STORE = "keys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheKey(cacheId: string, key: CryptoKey): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(key, cacheId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadCachedKey(cacheId: string): Promise<CryptoKey | null> {
  const db = await openDb();
  try {
    return await new Promise<CryptoKey | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(cacheId);
      req.onsuccess = () => resolve((req.result as CryptoKey | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function clearKeyCache(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
