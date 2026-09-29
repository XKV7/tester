/**
 * 에디터 작업 저장소 (IndexedDB). localStorage는 용량이 작고(약 5MB) 파일을 못 담아서,
 * 큰 레벨과 그림·음원 파일까지 함께 여기에 둔다. 실패해도 조용히 넘어간다.
 * 파일은 크니까 패키지가 바뀔 때만, 레벨은 고칠 때마다 저장한다.
 */

const DB = 'orbit';
const STORE = 'editor';

export interface EditorLevelSave {
  /** 패키지 id (파일 묶음과 짝) */
  id: string;
  level: string;
  imported?: 'adofai';
  source?: string;
  /** 불러온 뒤 사용자가 고쳤는지 (안 고쳤으면 원작 파일로 다시 변환해도 된다) */
  edited: boolean;
}

export interface EditorFilesSave {
  id: string;
  files: [string, Uint8Array][];
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexedDB'));
      return;
    }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get<T>(key: string): Promise<T | null> {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function put(key: string, value: unknown): Promise<boolean> {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } catch {
    return false;
  }
}

export const loadEditorLevel = () => get<EditorLevelSave>('level');
export const loadEditorFiles = () => get<EditorFilesSave>('files');
export const saveEditorLevel = (s: EditorLevelSave) => put('level', s);
export const saveEditorFiles = (s: EditorFilesSave) => put('files', s);
