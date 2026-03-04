import {
  EndBehaviorType,
  VoiceConnection,
  VoiceReceiver,
} from "@discordjs/voice";
import { type GuildMember, type TextChannel } from "discord.js";
import prism from "prism-media";
import { MIN_INPUT_BYTES, prepareWav } from "./audio-utils";
import { config } from "./config";
import { transcribe } from "./transcriber";
import { editMessage, postMessage } from "./webhook-manager";

/**
 * Serializes new message creation across all users in a guild.
 *
 * A slot is reserved BEFORE transcription starts, so the posting order
 * reflects the order flushes were initiated — not the order they finished.
 *
 * Edits to existing messages bypass the queue since they don't affect
 * channel ordering.
 */
class PostQueue {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Reserve a slot now. Returns an `execute` function to call later.
   * - Call `execute(fn)` to post and release the slot.
   * - Call `execute(null)` to release without posting (e.g. blank transcription).
   */
  reserve(): (fn: (() => Promise<string>) | null) => Promise<string> {
    let release!: () => void;
    const myTurn = this.tail;
    this.tail = new Promise((r) => {
      release = r;
    });

    return async (fn) => {
      await myTurn;
      try {
        return fn ? await fn() : "";
      } finally {
        release();
      }
    };
  }
}

// 500ms of audio at 48kHz stereo s16le = enough to count as real speech
const MIN_SPEECH_BYTES = 48000 * 4 * 0.5;

class UserSession {
  private buffer: Buffer[] = [];
  private chunks: Buffer[] = [];
  private messageId: string | null = null;
  private transcript = "";
  private flushing = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private audioSinceReset = 0;
  lastAudioTime = 0; // exposed for health check

  constructor(
    private readonly member: GuildMember,
    private readonly channel: TextChannel,
    private readonly queue: PostQueue
  ) {
    const jitter = Math.random() * config.flushIntervalMs;
    this.flushTimer = setTimeout(() => this.scheduleFlush(), jitter);
  }

  private scheduleFlush() {
    this.flushTimer = setTimeout(async () => {
      if (this.destroyed) return;
      await this.flush();
      this.scheduleFlush();
    }, config.flushIntervalMs);
  }

  onAudio(chunk: Buffer) {
    this.lastAudioTime = Date.now();
    this.buffer.push(chunk);
    this.audioSinceReset += chunk.length;

    if (this.silenceTimer === null) {
      // First audio of this utterance — start the timer
      this.resetSilenceTimer();
    } else if (this.audioSinceReset >= MIN_SPEECH_BYTES) {
      // Only extend the timer once 500ms+ of real speech has arrived
      this.audioSinceReset = 0;
      this.resetSilenceTimer();
    }
  }

  private resetSilenceTimer() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.finalize(), config.silenceFinalizeMs);
  }

  private async flush() {
    if (this.flushing || this.buffer.length === 0) return;

    const current = Buffer.concat(this.buffer);
    this.buffer = [];

    if (current.length < MIN_INPUT_BYTES) return;

    // Capture messageId NOW before any async work — finalize can null it mid-flight
    const messageId = this.messageId;
    const execute = messageId === null ? this.queue.reserve() : null;

    this.flushing = true;
    try {
      const text = await transcribe(prepareWav(current));

      if (!text) {
        await execute?.(null);
        return;
      }

      this.chunks.push(current);
      this.transcript += (this.transcript ? " " : "") + text;

      if (execute) {
        this.messageId = await execute(() =>
          postMessage(
            this.channel,
            this.transcript,
            this.member.displayName,
            this.member.displayAvatarURL()
          )
        );
      } else if (messageId) {
        await editMessage(this.channel, messageId, this.transcript);
      }
    } catch (err) {
      await execute?.(null);
      console.error(`[session:${this.member.displayName}]`, err);
    } finally {
      this.flushing = false;
    }
  }

  private async finalize() {
    while (this.flushing) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await this.flush();

    if (this.chunks.length > 1 && this.messageId) {
      try {
        const fullPcm = Buffer.concat(this.chunks);
        const corrected = await transcribe(prepareWav(fullPcm));
        // Only apply if corrected result isn't significantly shorter — whisper can
        // drop content on long audio, and a much shorter result almost always
        // means something was lost rather than genuinely corrected
        const existingWords = this.transcript.trim().split(/\s+/).length;
        const correctedWords = corrected.trim().split(/\s+/).length;
        if (corrected && correctedWords >= existingWords * 0.85) {
          this.transcript = corrected;
          await editMessage(this.channel, this.messageId, this.transcript);
        }
      } catch (err) {
        console.error(`[session:${this.member.displayName}] correction pass`, err);
      }
    }

    this.chunks = [];
    this.messageId = null;
    this.transcript = "";
    this.audioSinceReset = 0;
    this.silenceTimer = null;
  }

  destroy() {
    this.destroyed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
  }
}

const HEALTH_CHECK_INTERVAL_MS = 10_000;
// If a user starts speaking but no audio arrives within this window, reattach
const SPEAKING_GRACE_MS = 1500;

export class VoiceManager {
  private sessions = new Map<string, UserSession>();
  private members = new Map<string, GuildMember>();
  private streams = new Map<string, ReturnType<VoiceReceiver["subscribe"]>>();
  private speakingAt = new Map<string, number>(); // userId → timestamp they started speaking
  private healthCheck: ReturnType<typeof setInterval>;
  private queue = new PostQueue();

  constructor(
    private readonly connection: VoiceConnection,
    readonly textChannel: TextChannel
  ) {
    this.healthCheck = setInterval(() => this.checkStreams(), HEALTH_CHECK_INTERVAL_MS);

    this.connection.receiver.speaking.on("start", (userId) => {
      this.speakingAt.set(userId, Date.now());
    });
    this.connection.receiver.speaking.on("end", (userId) => {
      this.speakingAt.delete(userId);
    });
  }

  subscribe(member: GuildMember) {
    if (this.sessions.has(member.id)) return;
    this.members.set(member.id, member);
    const session = new UserSession(member, this.textChannel, this.queue);
    this.sessions.set(member.id, session);
    this.attachStream(member.id, session);
    console.log(`[voice] subscribed to ${member.displayName}`);
  }

  private attachStream(userId: string, session: UserSession) {
    this.streams.get(userId)?.destroy();

    const audioStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 2,
      rate: 48000,
    });

    decoder.on("data", (chunk: Buffer) => session.onAudio(chunk));

    const reattach = (reason: string) => {
      if (!this.sessions.has(userId)) return;
      const member = this.members.get(userId);
      console.log(`[voice] ${reason} for ${member?.displayName ?? userId}, reattaching`);
      setTimeout(() => {
        if (this.sessions.has(userId)) this.attachStream(userId, session);
      }, 500);
    };

    decoder.on("close", () => reattach("stream closed"));
    decoder.on("error", (err) => {
      console.error(`[voice] decoder error for ${this.members.get(userId)?.displayName ?? userId}:`, err.message);
      reattach("decoder error");
    });

    audioStream.pipe(decoder);
    this.streams.set(userId, audioStream);
  }

  private checkStreams() {
    const now = Date.now();

    for (const [userId, stream] of this.streams) {
      const session = this.sessions.get(userId);
      const member = this.members.get(userId);
      if (!session || !member) continue;

      // Destroyed stream
      if (stream.destroyed) {
        console.log(`[voice] health check: dead stream for ${member.displayName}, reattaching`);
        this.attachStream(userId, session);
        continue;
      }

      // Speaking indicator fired but no audio arrived within the grace window
      const speakingStart = this.speakingAt.get(userId);
      if (
        speakingStart &&
        now - speakingStart > SPEAKING_GRACE_MS &&
        session.lastAudioTime < speakingStart
      ) {
        console.log(`[voice] health check: ${member.displayName} speaking but no audio, reattaching`);
        this.attachStream(userId, session);
      }
    }
  }

  unsubscribe(userId: string) {
    this.streams.get(userId)?.destroy();
    this.streams.delete(userId);
    this.sessions.get(userId)?.destroy();
    this.sessions.delete(userId);
    this.members.delete(userId);
  }

  destroy() {
    clearInterval(this.healthCheck);
    for (const userId of [...this.sessions.keys()]) this.unsubscribe(userId);
    this.connection.destroy();
  }
}
