export function shortestChain(roots: string[], edges: (node: string) => string[], isTarget: (node: string) => boolean, label: (node: string) => string): string[] | null {
  const parent = new Map<string, string | null>(roots.map((root) => [root, null]));
  const queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]!;
    if (isTarget(node)) {
      const chain: string[] = [];
      for (let step: string | null = node; step !== null; step = parent.get(step) ?? null) chain.unshift(label(step));
      return chain;
    }
    for (const next of edges(node)) {
      if (parent.has(next)) continue;
      parent.set(next, node);
      queue.push(next);
    }
  }
  return null;
}
