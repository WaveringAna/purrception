import { join } from "node:path";

const STATE_FILE = join(import.meta.dir, "../.vc-state.json");

export interface VCState {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
}

export async function saveState(state: VCState): Promise<void> {
  await Bun.write(STATE_FILE, JSON.stringify(state));
}

export async function clearState(): Promise<void> {
  await Bun.write(STATE_FILE, "");
}

export async function loadState(): Promise<VCState | null> {
  const file = Bun.file(STATE_FILE);
  if (!(await file.exists())) return null;
  const text = await file.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as VCState;
  } catch {
    return null;
  }
}
