export function validVocabulary(term: unknown, meaning: unknown): boolean {
  return typeof term === "string" && typeof meaning === "string" &&
    term.trim().length > 0 && term.length <= 200 && meaning.trim().length > 0 && meaning.length <= 1000;
}
