/** Real Section 9 cron page. Must not be treated as a confirm/probe echo. */
export function isSection9AnalystPage(content: string): boolean {
  const text = content.toLowerCase();
  return (
    text.includes("section 9") &&
    (text.includes("earnings transcript analyst") || text.includes("analyst_agent_serve.py"))
  );
}

/**
 * Drop other bots' confirmation / probe echoes.
 * A Section 9 analyst page is never a ping, even if it contains words like "loop".
 */
export function isConfirmationPing(content: string): boolean {
  if (isSection9AnalystPage(content)) return false;
  const text = content.replace(/<@!?\d+>/g, "").trim().toLowerCase();
  if (!text) return false;
  // Codex gateway probe requests must wake the agent (not treat as echo).
  if (/reply exactly:\s*bridge probe\b/.test(text)) return false;
  return (
    /\b(confirm|confirmed|confirmation|ping-pong|ping pong|loop|stopped|no further|probe|understood)\b/.test(
      text,
    ) ||
    text.includes("applied universally") ||
    text.includes("stay silent")
  );
}
