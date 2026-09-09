export type RecommendationTopic = {
  uid: string;
  code: string;
  title: string;
  parent: string | null;
  trackable: boolean;
};

export type RecommendationSummary = {
  uid: string;
  progress: number;
  updatedAt: string;
  hasNote: boolean;
  title: string;
};

export type Recommendation = {
  topic: RecommendationTopic;
  reason: string;
};

export function recommendTopics(
  all: RecommendationTopic[],
  summaries: Record<string, RecommendationSummary>,
  currentUid?: string | null,
): Recommendation[] {
  const available = all.filter((topic) => topic.trackable);
  const byUid = new Map(all.map((topic) => [topic.uid, topic]));
  const parents = new Set(all.map((topic) => topic.parent));
  const leaves = available.filter((topic) => !parents.has(topic.uid));
  const recent = Object.values(summaries)
    .filter((summary) => byUid.get(summary.uid)?.trackable)
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.uid.localeCompare(b.uid),
    );
  const picked = new Set<string>();
  const result: Recommendation[] = [];
  const add = (topic: RecommendationTopic | undefined, reason: string) => {
    if (
      !topic ||
      topic.uid === currentUid ||
      summaries[topic.uid]?.progress === 100 ||
      picked.has(topic.uid)
    )
      return;
    picked.add(topic.uid);
    result.push({ topic, reason });
  };

  recent
    .filter((summary) => summary.progress < 100 && summary.uid !== currentUid)
    .slice(0, 2)
    .forEach((summary) => {
      add(
        available.find((topic) => topic.uid === summary.uid),
        summary.progress
          ? `继续上次 · 已学 ${summary.progress}%`
          : '接着上次的记录',
      );
    });

  const current = byUid.get(currentUid || recent[0]?.uid);
  if (current) {
    const isInside = (topic: RecommendationTopic) => {
      let parent = topic.parent;
      while (parent) {
        if (parent === current.uid) return true;
        parent = byUid.get(parent)?.parent || null;
      }
      return false;
    };
    const related = leaves
      .filter(
        (topic) =>
          !summaries[topic.uid] &&
          topic.uid !== current.uid &&
          (isInside(topic) ||
            (current.parent && topic.parent === current.parent)),
      )
      .sort(
        (a, b) =>
          Number(b.code > current.code) - Number(a.code > current.code) ||
          a.code.localeCompare(b.code),
      );
    related
      .slice(0, 2)
      .forEach((topic) =>
        add(
          topic,
          isInside(topic) ? '把这个主题再拆小一点' : '同一分类，接着探索',
        ),
      );
  }

  const starters = ['K18.16.01', 'K12.04.16.01', 'K45.04.01'];
  starters.forEach((code) => {
    add(
      available.find((topic) => topic.code === code),
      '入门灵感 · 选一个感兴趣的',
    );
  });
  for (const topic of leaves) {
    if (result.length >= 3) break;
    if (!summaries[topic.uid]) add(topic, '还没探索的小主题');
  }
  return result.slice(0, 3);
}

export function subtopicProgress(
  topics: RecommendationTopic[],
  summaries: Record<string, RecommendationSummary>,
) {
  const trackable = topics.filter((topic) => topic.trackable);
  return {
    total: trackable.length,
    completed: trackable.filter(
      (topic) => summaries[topic.uid]?.progress === 100,
    ).length,
    average: trackable.length
      ? Math.round(
          trackable.reduce(
            (sum, topic) => sum + (summaries[topic.uid]?.progress || 0),
            0,
          ) / trackable.length,
        )
      : 0,
  };
}

/** Pick a different unfinished leaf, sampling domains before topics for variety. */
export function randomTopic(
  all: RecommendationTopic[],
  summaries: Record<string, RecommendationSummary>,
  currentUid?: string,
  recent: string[] = [],
  random: () => number = Math.random,
): Recommendation | null {
  const parents = new Set(all.map((topic) => topic.parent));
  const available = all.filter(
    (topic) =>
      topic.trackable &&
      !parents.has(topic.uid) &&
      topic.uid !== currentUid &&
      summaries[topic.uid]?.progress !== 100,
  );
  if (!available.length) return null;
  const unseen = available.filter((topic) => !recent.includes(topic.uid));
  let pool = unseen.length ? unseen : available;
  const currentDomain = all
    .find((topic) => topic.uid === currentUid)
    ?.code.split('.')[0];
  const otherDomains = pool.filter(
    (topic) => topic.code.split('.')[0] !== currentDomain,
  );
  if (otherDomains.length) pool = otherDomains;
  const domains = [...new Set(pool.map((topic) => topic.code.split('.')[0]))];
  const pick = <T>(items: T[]) =>
    items[
      Math.min(
        items.length - 1,
        Math.max(0, Math.floor(random() * items.length)),
      )
    ];
  const domain = pick(domains);
  return {
    topic: pick(pool.filter((topic) => topic.code.split('.')[0] === domain)),
    reason: '随机发现 · 换个小主题看看',
  };
}
