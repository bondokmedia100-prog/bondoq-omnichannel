export function chooseRoundRobinAgent<T extends { id: string }>(agents: T[], roundRobinTurn: number): T | undefined {
  if (!agents.length) return undefined;
  const index = ((roundRobinTurn % agents.length) + agents.length) % agents.length;
  return agents[index];
}
