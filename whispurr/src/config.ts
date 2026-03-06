/**
 * Global defaults used when a new channel session is created.
 * Each active channel gets its own copy of these values via `VoiceManager.channelConfig`,
 * which can be overridden per-channel with /stt-config and is persisted across restarts.
 */
export const config = {
  /** How often to flush audio buffer to whisper (ms) */
  flushIntervalMs: 3000,
  /** How long per-user silence before finalizing their message (ms) */
  silenceFinalizeMs: 1500,
};
