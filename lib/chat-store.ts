import { emptyChat, validateChat, type TopicChat } from './topic-chat.ts';

/** Separate device-local storage; it never stores provider connection settings. */
export function createChatStore(factory: IDBFactory) {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open('world-learning-chats', 1);
      let failed = false;
      req.onupgradeneeded = () =>
        req.result.createObjectStore('chats', { keyPath: 'uid' });
      req.onblocked = req.onerror = () => {
        failed = true;
        reject(new Error('对话存储不可用，请检查浏览器空间或关闭旧页面后重试'));
      };
      req.onsuccess = () => {
        if (failed) {
          req.result.close();
          return;
        }
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
    });
  return {
    async get(uid: string): Promise<TopicChat> {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('chats', 'readonly');
        const req = tx.objectStore('chats').get(uid);
        tx.oncomplete = () => {
          db.close();
          resolve(req.result || emptyChat(uid));
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(new Error('读取对话失败'));
        };
      });
    },
    async all(): Promise<TopicChat[]> {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('chats', 'readonly');
        const req = tx.objectStore('chats').getAll();
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(new Error('读取对话失败'));
        };
      });
    },
    async write(
      value: TopicChat,
      expectedRevision: number,
    ): Promise<TopicChat> {
      const chat = validateChat(value);
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('chats', 'readwrite');
        const store = tx.objectStore('chats');
        const req = store.get(chat.uid);
        let result: TopicChat;
        let error: Error | undefined;
        req.onsuccess = () => {
          if ((req.result?.revision || 0) !== expectedRevision) {
            error = new Error(
              '另一页面更新了这段对话。请先导出当前内容，再重新打开主题',
            );
            tx.abort();
            return;
          }
          result = {
            ...chat,
            revision: expectedRevision + 1,
            updatedAt: new Date().toISOString(),
          };
          store.put(result);
        };
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(
            error || new Error('对话未保存，请保持页面打开并导出当前内容'),
          );
        };
      });
    },
  };
}
let store: ReturnType<typeof createChatStore> | undefined;
const flushers = new Set<() => Promise<void>>();
export function registerChatFlush(flush: () => Promise<void>) {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}
export async function flushChatSaves() {
  await Promise.all([...flushers].map((flush) => flush()));
}
export const chatStore = () => {
  if (typeof indexedDB === 'undefined') throw new Error('本机存储不可用');
  return (store ||= createChatStore(indexedDB));
};
