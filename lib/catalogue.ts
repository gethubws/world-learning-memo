import data from './catalogue-data.json';
import { buildTeachingPrompt, type OutlineItem } from './learning-prompt';
export type Topic = Omit<(typeof data.nodes)[number], 'revision'>;
export const catalogueVersion = data.version;
export const nodes: Topic[] = data.nodes;
export const nodeMap = new Map(nodes.map((n) => [n.uid, n]));
export const roots = nodes.filter((n) => !n.parent);
const childMap = new Map<string, Topic[]>();
for (const n of nodes) {
  if (n.parent) {
    const siblings = childMap.get(n.parent) || [];
    siblings.push(n);
    childMap.set(n.parent, siblings);
  }
}
export function childrenOf(node: Topic): Topic[] {
  return childMap.get(node.uid) || [];
}
export function outlineOf(node: Topic): OutlineItem[] {
  const result: OutlineItem[] = [];
  const visit = (parent: Topic, depth: number) => {
    for (const child of childrenOf(parent)) {
      result.push({ code: child.code, title: child.title, depth });
      visit(child, depth + 1);
    }
  };
  visit(node, 1);
  return result;
}
export function pathOf(node: Topic): Topic[] {
  const path = [node];
  let parent = node.parent;
  while (parent) {
    const p = nodeMap.get(parent);
    if (!p) break;
    path.unshift(p);
    parent = p.parent;
  }
  return path;
}
export function inScope(n: Topic, uid: string | null) {
  return !uid || pathOf(n).some((p) => p.uid === uid);
}
export function teachingPrompt(
  node: Topic,
  title: string,
  points: string[] = [],
) {
  return buildTeachingPrompt({
    code: node.code,
    title,
    originalTitle: node.title,
    path: pathOf(node).map((n) => n.title),
    version: catalogueVersion,
    outline: outlineOf(node),
    personalPoints: points,
  });
}
