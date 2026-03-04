/** Runtime-mutable config. Modify via /stt-config slash command. */
export const config = {
  /** How often to flush audio buffer to whisper (ms) */
  flushIntervalMs: 3000,
  /** How long per-user silence before finalizing their message (ms) */
  silenceFinalizeMs: 3000,
};
