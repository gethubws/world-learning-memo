import {
  contentOf,
  emptyMemo,
  validateMemo,
  type SavedMemo,
  type Summary,
} from './records.ts';

export const LOCAL_PROFILE = 'device-local-v1';
const DATABASE = 'world-learning-local';
const storageError = () =>
  new Error(
    '本机存储暂时不可用，请使用普通浏览窗口、检查可用空间，或先导出当前笔记',
  );

/** Device-only records. Each write checks its revision and updates its summary atomically. */
export function createLocalMemoStore(factory: IDBFactory) {
  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = factory.open(DATABASE, 1);
      let failed = false;
      req.onupgradeneeded = () => {
        req.result.createObjectStore('memos', { keyPath: 'uid' });
        req.result.createObjectStore('summaries', { keyPath: 'uid' });
      };
      req.onblocked = () => {
        failed = true;
        reject(storageError());
      };
      req.onerror = () => reject(storageError());
      req.onsuccess = () => {
        if (failed) {
          req.result.close();
          return;
        }
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
    });
  }
  async function read<T>(
    store: string,
    operation: (s: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = operation(tx.objectStore(store));
      tx.oncomplete = () => {
        db.close();
        resolve(req.result as T);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(storageError());
      };
    });
  }
  async function write(
    record: unknown,
    expectedRevision: number,
  ): Promise<SavedMemo> {
    const memo = validateMemo(record);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error('记录版本不正确');
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['memos', 'summaries'], 'readwrite');
      const memos = tx.objectStore('memos');
      let result: SavedMemo;
      let failure: Error | null = null;
      const req = memos.get(memo.uid);
      req.onsuccess = () => {
        const current: SavedMemo = req.result || emptyMemo(memo.uid);
        if (current.revision !== expectedRevision) {
          failure = Object.assign(
            new Error('另一个页面修改了此主题，请保留两份后合并'),
            { status: 409, data: { current } },
          );
          tx.abort();
          return;
        }
        result = {
          ...memo,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        const summary: Summary = {
          uid: result.uid,
          title: result.title,
          progress: result.progress,
          hasNote: !!result.note,
          revision: result.revision,
          updatedAt: result.updatedAt,
        };
        memos.put(result);
        tx.objectStore('summaries').put(summary);
      };
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(failure || storageError());
      };
    });
  }
  return {
    summaries: () => read<Summary[]>('summaries', (s) => s.getAll()),
    get: async (uid: string) =>
      (await read<SavedMemo | undefined>('memos', (s) => s.get(uid))) ||
      emptyMemo(uid),
    page: async (after = '') => {
      // Cursor pagination avoids reading every long note into memory at once.
      const db = await open();
      return new Promise<{ records: SavedMemo[]; nextCursor: string | null }>(
        (resolve, reject) => {
          const tx = db.transaction('memos', 'readonly'),
            records: SavedMemo[] = [];
          const req = tx
            .objectStore('memos')
            .openCursor(after ? IDBKeyRange.lowerBound(after, true) : null);
          let more = false;
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            if (records.length === 10) {
              more = true;
              return;
            }
            records.push(cursor.value);
            cursor.continue();
          };
          tx.oncomplete = () => {
            db.close();
            resolve({
              records,
              nextCursor: more ? records[records.length - 1].uid : null,
            });
          };
          tx.onabort = tx.onerror = () => {
            db.close();
            reject(storageError());
          };
        },
      );
    },
    write,
  };
}
let local: ReturnType<typeof createLocalMemoStore> | undefined;
function deviceStore() {
  if (typeof indexedDB === 'undefined') throw storageError();
  return (local ||= createLocalMemoStore(indexedDB));
}

/** Compatible with the editor's existing read/save contract, but never uses fetch. */
export async function localApi<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = new URL(path, 'https://local.invalid');
  if (url.pathname !== '/api/memos' || url.origin !== 'https://local.invalid')
    throw new Error('未知本机操作');
  const store = deviceStore();
  if (options.method === 'POST') {
    const input = JSON.parse(String(options.body));
    const result = await store.write(
      contentOf(validateMemo(input.record)),
      input.expectedRevision,
    );
    return { record: result } as T;
  }
  if (options.method && options.method !== 'GET')
    throw new Error('不支持的本机操作');
  const uid = url.searchParams.get('topic');
  if (uid) return { profile: LOCAL_PROFILE, record: await store.get(uid) } as T;
  if (url.searchParams.has('export'))
    return (await store.page(url.searchParams.get('after') || '')) as T;
  return { profile: LOCAL_PROFILE, summaries: await store.summaries() } as T;
}
