const DATABASE = 'eval-studio-interface-preview';
const STORE = 'values';
let connection: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (!connection) {
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { connection = undefined; reject(request.error); };
    });
  }
  return connection;
}

export async function getValue<T>(key: string, fallback: T): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result === undefined ? fallback : request.result as T);
    request.onerror = () => reject(request.error);
  });
}

export async function setValue<T>(key: string, value: T): Promise<void> {
  return setValues([[key, value]]);
}

export async function setValues(entries: [string, unknown][]): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    entries.forEach(([key, value]) => transaction.objectStore(STORE).put(value, key));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('保存中断'));
  });
}

export async function exportPreview(): Promise<{ format: string; version: number; dataSource: string; exportedAt: string; entries: { key: string; value: unknown }[] }> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE);
    const keys = transaction.objectStore(STORE).getAllKeys();
    const values = transaction.objectStore(STORE).getAll();
    transaction.oncomplete = () => resolve({ format: 'eval-studio-preview', version: 1, dataSource: 'demo', exportedAt: new Date().toISOString(), entries: keys.result.map((key, i) => ({ key: String(key), value: values.result[i] })) });
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function importPreview(raw: unknown): Promise<number> {
  const packet = raw as { format?: string; version?: number; dataSource?: string; entries?: { key: string; value: unknown }[] };
  if (!packet || packet.format !== 'eval-studio-preview' || packet.version !== 1 || packet.dataSource !== 'demo' || !Array.isArray(packet.entries)) throw new Error('请选择本界面导出的演示备份文件');
  if (packet.entries.length > 2000 || packet.entries.some(e => !e || typeof e.key !== 'string' || e.key.length > 200)) throw new Error('备份文件格式不正确');
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    packet.entries!.forEach(entry => transaction.objectStore(STORE).put(entry.value, entry.key));
    transaction.oncomplete = () => resolve(packet.entries!.length);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
