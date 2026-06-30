export function createCorrelationId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}
