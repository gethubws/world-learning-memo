import type { Memo } from './records';
export type Draft = {
  key: string;
  profile: string;
  record: Memo;
  baseRevision: number;
  updatedAt: string;
};
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('world-learning-drafts', 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore('drafts', { keyPath: 'key' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function operate<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', mode);
    const req = action(tx.objectStore('drafts'));
    tx.oncomplete = () => {
      db.close();
      resolve(req.result as T);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error || new Error('草稿保存中断'));
    };
  });
}
export function draftKey(profile: string, uid: string) {
  return `${profile}:${uid}`;
}
export const getDraft = (profile: string, uid: string) =>
  operate<Draft | undefined>('readonly', (s) => s.get(draftKey(profile, uid)));
export const saveDraft = (
  profile: string,
  record: Memo,
  baseRevision: number,
) =>
  operate<IDBValidKey>('readwrite', (s) =>
    s.put({
      key: draftKey(profile, record.uid),
      profile,
      record,
      baseRevision,
      updatedAt: new Date().toISOString(),
    }),
  );
export const removeDraft = (profile: string, uid: string) =>
  operate<undefined>('readwrite', (s) => s.delete(draftKey(profile, uid)));
export async function allDrafts(profile: string) {
  return (await operate<Draft[]>('readonly', (s) => s.getAll())).filter(
    (d) => d.profile === profile,
  );
}
