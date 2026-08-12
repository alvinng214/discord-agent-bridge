const DISCORD_SAFE_LIMIT = 1900;

/**
 * Split text into Discord-safe chunks (~1900 chars), preferring paragraph
 * then newline then space boundaries.
 */
export function splitMessage(text: string, limit = DISCORD_SAFE_LIMIT): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    let cut =
      window.lastIndexOf("\n\n") >= 0
        ? window.lastIndexOf("\n\n")
        : window.lastIndexOf("\n") >= 0
          ? window.lastIndexOf("\n")
          : window.lastIndexOf(" ");

    if (cut < Math.floor(limit * 0.4)) {
      cut = limit;
    }

    const piece = remaining.slice(0, cut).trimEnd();
    if (piece) chunks.push(piece);
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
