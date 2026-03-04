/** Runtime-mutable config. Modify via /stt-config slash command. */
export const config = {
  /** How often to flush audio buffer to whisper (ms) */
  flushIntervalMs: 3000,
  /** How long per-user silence before finalizing their message (ms) */
  silenceFinalizeMs: 3000,
  /**
   * Minimum ratio of corrected words to accumulated words before accepting
   * the correction pass result (0–1). Lower = more permissive corrections,
   * higher = stricter (protects against whisper dropping content on long audio).
   */
  correctionThreshold: 0.85,
};
