const WHISPER_URL = process.env.WHISPER_URL ?? "http://localhost:8080";

export async function transcribe(wav: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "json");

  const res = await fetch(`${WHISPER_URL}/inference`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    console.error(`[whisper] ${res.status} ${res.statusText}`);
    return "";
  }

  const data = (await res.json()) as { text?: string };
  const raw = data.text?.trim() ?? "";
  if (isBlank(raw)) return "";
  return postProcess(raw);
}

// ── Post-processing passes ────────────────────────────────────────────────────
// Each entry is applied in order. Use a string for literal replacement or a
// function for context-aware logic.

type Pass = [pattern: RegExp, replacement: string | ((match: string, offset: number, str: string) => string)];

const PASSES: Pass[] = [
  // Lowercase everything
  [/^[\s\S]*$/, (match) => match.toLowerCase()],
  // Strip periods
  [/\./g, ""],
  // Remove leading bullet dash
  [/^-\s*/, ""],
  // Replace "he" → "she", but leave stutters like "he he he" alone
  [/\bhe\b/g, (match, offset, str) => {
    const before = str.slice(0, offset);
    const after = str.slice(offset + match.length);
    if (/\bhe\s+$/.test(before) || /^\s+he\b/.test(after)) return match;
    return "she";
  }],
  // Replace "man" → "woman"
  [/\bman\b/g, "woman"],
];

function postProcess(text: string): string {
  return PASSES.reduce((t, [pattern, replacement]) => t.replace(pattern, replacement as string), text);
}

// Whisper hallucinations on short/silent audio
const BLANK_PATTERNS = /^\s*(\[.*?\]|\(.*?\)|\.{2,})\s*$/i;
const HALLUCINATIONS = [
  "thank you",
  "thank you.",
  "thanks for watching",
  "you",
  "bye",
  "bye.",
  ".",
  "!",
];

function isBlank(text: string): boolean {
  if (text === "") return true;
  if (BLANK_PATTERNS.test(text)) return true;
  if (HALLUCINATIONS.includes(text.toLowerCase().trim())) return true;
  return false;
}
