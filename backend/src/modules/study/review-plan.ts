export const reviewOffsets = [0, 1, 3, 6, 13, 29] as const;

export function reviewDayNumbers(targetDayNumber: number) {
  return reviewOffsets
    .map((offset) => targetDayNumber - offset)
    .filter((dayNumber) => dayNumber > 0);
}

export function shuffled<T>(items: readonly T[], random = Math.random) {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }

  return result;
}

export function shuffledWithinDays<T>(items: readonly T[], dayNumber: (item: T) => number, random = Math.random) {
  const groups = new Map<number, T[]>();
  for (const item of items) {
    const day = dayNumber(item);
    groups.set(day, [...(groups.get(day) ?? []), item]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => right - left)
    .flatMap(([, group]) => shuffled(group, random));
}
