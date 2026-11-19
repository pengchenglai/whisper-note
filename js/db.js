// 笔记和录音都存在本机的 IndexedDB 里，不上传到任何服务器

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('whisper-note', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(stores, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('存储写入被中止'));
    const out = fn(tx);
    if (out && 'onsuccess' in out) out.onsuccess = () => (result = out.result);
  });
}

export async function listNotes() {
  const notes = (await run(['notes'], 'readonly', (tx) => tx.objectStore('notes').getAll())) || [];
  return notes.sort((a, b) => b.createdAt - a.createdAt);
}

export function getNote(id) {
  return run(['notes'], 'readonly', (tx) => tx.objectStore('notes').get(id));
}

export function putNote(note) {
  return run(['notes'], 'readwrite', (tx) => {
    tx.objectStore('notes').put(note);
  });
}

export function deleteNote(id) {
  return run(['notes', 'audio'], 'readwrite', (tx) => {
    tx.objectStore('notes').delete(id);
    tx.objectStore('audio').delete(id);
  });
}

// 存成 ArrayBuffer 而不是 Blob：旧版 iOS 的 IndexedDB 存 Blob 不稳定
export async function putAudio(id, blob) {
  const data = await blob.arrayBuffer();
  return run(['audio'], 'readwrite', (tx) => {
    tx.objectStore('audio').put({ id, type: blob.type, data });
  });
}

export async function getAudio(id) {
  const rec = await run(['audio'], 'readonly', (tx) => tx.objectStore('audio').get(id));
  if (!rec || !rec.data) return null;
  return new Blob([rec.data], { type: rec.type || 'audio/mp4' });
}
