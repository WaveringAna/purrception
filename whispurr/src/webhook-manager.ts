import { type TextChannel, type Webhook } from "discord.js";

// One webhook per channel, cached for the process lifetime
const cache = new Map<string, Webhook>();

export async function getWebhook(channel: TextChannel): Promise<Webhook> {
  if (cache.has(channel.id)) return cache.get(channel.id)!;

  const existing = await channel.fetchWebhooks().catch((err) => {
    if (err?.code === 50013) {
      throw new Error(`Bot is missing Manage Webhooks permission in #${channel.name}`);
    }
    throw err;
  });
  let hook = existing.find(
    (w) => w.owner?.id === channel.client.user?.id && w.name === "vc-stt"
  );

  if (!hook) {
    hook = await channel.createWebhook({ name: "vc-stt" });
  }

  cache.set(channel.id, hook);
  return hook;
}

export async function postMessage(
  channel: TextChannel,
  content: string,
  username: string,
  avatarURL: string
): Promise<string> {
  const hook = await getWebhook(channel);
  const msg = await hook.send({ content, username, avatarURL, fetchReply: true });
  return msg.id;
}

export async function editMessage(
  channel: TextChannel,
  messageId: string,
  content: string
): Promise<void> {
  const hook = await getWebhook(channel);
  await hook.editMessage(messageId, { content });
}
