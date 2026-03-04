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
  const text = data.text?.trim() ?? "";
  return isBlank(text) ? "" : text;
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
