export function chooseLeastLoadedAgent<T extends { id: string }>(
  agents: T[],
  activeCounts: Map<string, number>,
  roundRobinTurn: number
): T | undefined {
  if (!agents.length) return undefined;
  const minimum = Math.min(...agents.map((agent) => activeCounts.get(agent.id) || 0));
  const leastLoaded = agents.filter((agent) => (activeCounts.get(agent.id) || 0) === minimum);
  const index = ((roundRobinTurn % leastLoaded.length) + leastLoaded.length) % leastLoaded.length;
  return leastLoaded[index];
}
