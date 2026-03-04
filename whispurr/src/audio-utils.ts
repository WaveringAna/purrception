import { resample } from "wave-resampler";

/**
 * Discord voice out: 48kHz stereo s16le PCM (prism-media Opus decoded)
 * whisper-server wants: 16kHz mono s16le in a WAV container
 */
export function prepareWav(input: Buffer): Buffer {
  // s16le stereo Buffer → Int16Array, then mix to mono
  const stereo = new Int16Array(input.buffer, input.byteOffset, input.length / 2);
  const mono = new Int16Array(stereo.length / 2);
  for (let i = 0; i < mono.length; i++) {
    mono[i] = Math.round((stereo[i * 2]! + stereo[i * 2 + 1]!) / 2);
  }

  // resample mutates input, so pass a copy; cubic+LPF is fast enough for speech
  const resampled = resample(Int16Array.from(mono), 48000, 16000, { method: "cubic" });

  // Float64Array (still in Int16 range) → s16le Buffer
  const pcm = Buffer.allocUnsafe(resampled.length * 2);
  for (let i = 0; i < resampled.length; i++) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(resampled[i]!))), i * 2);
  }

  return wrapWav(pcm);
}

function wrapWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  const header = Buffer.allocUnsafe(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Minimum raw PCM bytes to bother transcribing (~1s at 48kHz stereo s16le) */
export const MIN_INPUT_BYTES = 48000 * 4 * 1.0;
