const FORBIDDEN_KEY =
  /(password|passwd|secret|token|cookie|authorization|api[_-]?key|credential|backup|private[_-]?key)/i;

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = FORBIDDEN_KEY.test(key) ? '[redacted]' : redactValue(child, depth + 1);
    }
    return output;
  }
  return '[unserializable]';
}

export function redact<T>(value: T): T {
  return redactValue(value) as T;
}
