// Escapes PostgreSQL LIKE metacharacters so user search terms are matched
// literally instead of being interpreted as wildcards.
export function escapeLike(value: string): string {
  let output = '';
  for (const character of value) {
    if (character === '%' || character === '_' || character === '\\') output += '\\';
    output += character;
  }
  return output;
}
