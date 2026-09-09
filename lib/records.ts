export type Point = { id: string; title: string; done: boolean };
export type Memo = {
  uid: string;
  title: string;
  progress: number;
  note: string;
  points: Point[];
};
export type SavedMemo = Memo & { revision: number; updatedAt: string };
export type Summary = {
  uid: string;
  title: string;
  progress: number;
  hasNote: boolean;
  revision: number;
  updatedAt: string;
};
export const MAX_NOTE = 200_000;
export const MAX_POINTS = 200;
export function emptyMemo(uid: string): SavedMemo {
  return {
    uid,
    title: '',
    progress: 0,
    note: '',
    points: [],
    revision: 0,
    updatedAt: '',
  };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validateMemo(value: unknown): Memo {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('笔记格式不正确');
  const v = value as Record<string, unknown>;
  const keys = ['uid', 'title', 'progress', 'note', 'points'];
  if (
    Object.keys(v).some((k) => !keys.includes(k)) ||
    keys.some((k) => !(k in v))
  )
    throw new Error('笔记字段不完整或包含未知字段');
  if (typeof v.uid !== 'string' || !uuid.test(v.uid))
    throw new Error('主题编号不正确');
  if (typeof v.title !== 'string' || v.title.length > 300)
    throw new Error('标题最多 300 字');
  if (
    !Number.isInteger(v.progress) ||
    (v.progress as number) < 0 ||
    (v.progress as number) > 100
  )
    throw new Error('完成度必须是 0 至 100 的整数');
  if (typeof v.note !== 'string' || v.note.length > MAX_NOTE)
    throw new Error('每个主题的笔记最多 20 万字，请分到更多主题');
  if (!Array.isArray(v.points) || v.points.length > MAX_POINTS)
    throw new Error('每个主题最多 200 个知识点');
  const seen = new Set<string>();
  const points: Point[] = v.points.map((p) => {
    if (
      !p ||
      typeof p !== 'object' ||
      Object.keys(p).sort().join(',') !== 'done,id,title' ||
      typeof p.id !== 'string' ||
      !uuid.test(p.id) ||
      seen.has(p.id) ||
      typeof p.title !== 'string' ||
      !p.title.trim() ||
      p.title.length > 300 ||
      typeof p.done !== 'boolean'
    )
      throw new Error('知识点内容或编号不正确');
    seen.add(p.id);
    return { id: p.id, title: p.title, done: p.done };
  });
  const result = {
    uid: v.uid,
    title: v.title,
    progress: v.progress as number,
    note: v.note,
    points,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 900_000)
    throw new Error('笔记保存体积过大，请拆分到更多主题');
  return result;
}
export function contentOf(m: Memo): Memo {
  return {
    uid: m.uid,
    title: m.title,
    progress: m.progress,
    note: m.note,
    points: m.points,
  };
}
export function extractHeadings(text: string, existing: string[]): string[] {
  const found = new Set(existing.map((t) => t.trim()));
  const result: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (delimiter) {
      if (!fence)
        fence = { marker: delimiter[1][0], length: delimiter[1].length };
      else if (
        delimiter[1][0] === fence.marker &&
        delimiter[1].length >= fence.length &&
        !delimiter[2].trim()
      )
        fence = null;
      continue;
    }
    if (fence) continue;
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    const title = match?.[1]?.trim();
    if (title && title.length <= 300 && !found.has(title)) {
      found.add(title);
      result.push(title);
    }
  }
  return result.slice(0, Math.max(0, MAX_POINTS - existing.length));
}
export function validateBackup(value: unknown): Memo[] {
  const b = value as {
    format?: string;
    schemaVersion?: number;
    records?: unknown[];
  };
  if (
    !b ||
    b.format !== 'world-learning-memo' ||
    b.schemaVersion !== 1 ||
    !Array.isArray(b.records) ||
    b.records.length > 10000
  )
    throw new Error('请选择本应用导出的备份文件');
  const records = b.records.map(validateMemo);
  if (new Set(records.map((r) => r.uid)).size !== records.length)
    throw new Error('备份里有重复主题，尚未导入');
  return records;
}
