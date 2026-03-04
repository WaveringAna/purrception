import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  generateDependencyReport,
} from "@discordjs/voice";
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  TextChannel,
} from "discord.js";
import { config } from "./config";
import { clearState, loadState, saveState } from "./persistence";
import { VoiceManager } from "./voice";

// Prevent DAVE decrypt errors (thrown inside library UDP handler) from crashing
process.on("uncaughtException", (err) => {
  console.error("[uncaught]", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[unhandled rejection]", err);
});

async function shutdown() {
  console.log("[bot] Shutting down...");
  const notices = [...managers.entries()].map(([guildId, manager]) =>
    status(manager.textChannel, "Process stopped").then(() => {
      manager.destroy();
      managers.delete(guildId);
    })
  );
  await Promise.allSettled(notices);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// Active VoiceManager per guild
const managers = new Map<string, VoiceManager>();

async function status(channel: TextChannel, msg: string) {
  await channel.send(`*${msg}*`).catch(() => {});
}

function destroyManager(guildId: string, persist = true, reason?: string) {
  const manager = managers.get(guildId);
  if (manager && reason) {
    status(manager.textChannel, reason).catch(() => {});
  }
  manager?.destroy();
  managers.delete(guildId);
  if (persist) clearState();
}

// ── Slash command definitions ────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your voice channel and start transcribing to #vc-text"),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Stop transcribing and leave the voice channel"),

  new SlashCommandBuilder()
    .setName("stt-config")
    .setDescription("Tune transcription timing (changes take effect immediately)")
    .addIntegerOption((o) =>
      o
        .setName("flush_interval")
        .setDescription("How often to send audio to Whisper in ms (default 3000)")
        .setMinValue(500)
        .setMaxValue(10000)
    )
    .addIntegerOption((o) =>
      o
        .setName("silence_finalize")
        .setDescription("Silence duration before finalizing a message in ms (default 3000)")
        .setMinValue(500)
        .setMaxValue(15000)
    ),
].map((c) => c.toJSON());

// ── Register commands on startup ─────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN!);
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!), {
    body: commands,
  });
  console.log("[bot] Slash commands registered");
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleJoin(interaction: ChatInputCommandInteraction) {
  const member = interaction.member as GuildMember;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    await interaction.reply({ content: "You need to be in a voice channel.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (managers.has(interaction.guildId!)) {
    await interaction.reply({ content: "Already transcribing in this server.", flags: MessageFlags.Ephemeral });
    return;
  }

  const guild = interaction.guild!;
  const textChannel =
    (guild.channels.cache.find(
      (c) => c.name === "vc-text" && c.isTextBased()
    ) as TextChannel | undefined) ?? (interaction.channel as TextChannel);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  connection.on("stateChange", (oldState, newState) => {
    console.log(`[voice] ${oldState.status} → ${newState.status}`);
  });
  connection.on("error", (err) => {
    console.error("[voice] connection error:", err);
  });
  connection.on("stateChange", (_old, newState) => {
    if (newState.status === VoiceConnectionStatus.Destroyed) {
      destroyManager(guild.id, true, `Disconnected from **${voiceChannel.name}**`);
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  } catch (err) {
    console.error("[bot] Failed to enter Ready state:", err);
    connection.destroy();
    await interaction.editReply(`Failed to join voice channel: ${err}`);
    return;
  }

  const manager = new VoiceManager(connection, textChannel);
  managers.set(guild.id, manager);

  for (const [, m] of voiceChannel.members) {
    if (!m.user.bot) manager.subscribe(m);
  }

  await saveState({ guildId: guild.id, voiceChannelId: voiceChannel.id, textChannelId: textChannel.id });
  await status(textChannel, `Now transcribing **${voiceChannel.name}**`);
  await interaction.editReply(`Transcribing **${voiceChannel.name}** → ${textChannel}`);
  console.log(`[bot] Joined ${voiceChannel.name} in ${guild.name}`);
}

async function handleLeave(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  if (!managers.has(guildId)) {
    await interaction.reply({ content: "Not currently transcribing.", flags: MessageFlags.Ephemeral });
    return;
  }
  destroyManager(guildId, true, "Stopped transcribing");
  await interaction.reply({ content: "Left and stopped transcribing.", flags: MessageFlags.Ephemeral });
}

async function handleConfig(interaction: ChatInputCommandInteraction) {
  const flush = interaction.options.getInteger("flush_interval");
  const silence = interaction.options.getInteger("silence_finalize");

  if (flush) config.flushIntervalMs = flush;
  if (silence) config.silenceFinalizeMs = silence;

  await interaction.reply({
    content: [
      "**STT config updated:**",
      `• Flush interval: **${config.flushIntervalMs}ms**`,
      `• Silence finalize: **${config.silenceFinalizeMs}ms**`,
    ].join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

// ── Events ────────────────────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === "join") await handleJoin(interaction);
    else if (interaction.commandName === "leave") await handleLeave(interaction);
    else if (interaction.commandName === "stt-config") await handleConfig(interaction);
  } catch (err) {
    console.error("[bot] Command error:", err);
  }
});

client.on("voiceStateUpdate", (oldState, newState) => {
  if (oldState.member?.user.bot || newState.member?.user.bot) return;

  const guildId = newState.guild.id;
  const manager = managers.get(guildId);
  if (!manager) return;

  const botChannelId = newState.guild.members.me?.voice.channelId;
  if (!botChannelId) return;

  // Member joined the bot's channel
  if (newState.channelId === botChannelId && newState.member) {
    manager.subscribe(newState.member);
  }

  // Member left the bot's channel
  if (oldState.channelId === botChannelId && newState.channelId !== botChannelId) {
    manager.unsubscribe(oldState.id);

    const channel = oldState.channel;
    const remaining = channel?.members.filter((m) => !m.user.bot).size ?? 0;
    if (remaining === 0) {
      console.log(`[bot] Everyone left ${channel?.name}, auto-leaving`);
      destroyManager(guildId, true, `Everyone left **${channel?.name}**, stopped transcribing`);
    }
  }
});

client.once("clientReady", async () => {
  console.log(`[bot] Logged in as ${client.user!.tag}`);
  console.log(generateDependencyReport());
  await registerCommands();
  await tryReconnect();
});

async function tryReconnect() {
  const state = await loadState();
  if (!state) return;

  console.log(`[bot] Reconnecting to last VC (guild ${state.guildId})...`);

  const guild = client.guilds.cache.get(state.guildId);
  const voiceChannel = guild?.channels.cache.get(state.voiceChannelId);
  const textChannel = guild?.channels.cache.get(state.textChannelId) as TextChannel | undefined;

  if (!guild || !voiceChannel?.isVoiceBased() || !textChannel) {
    console.warn("[bot] Saved VC state is stale, clearing");
    await clearState();
    return;
  }

  await status(textChannel, `Reconnecting to **${voiceChannel.name}**...`);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  connection.on("stateChange", (oldState, newState) => {
    console.log(`[voice] ${oldState.status} → ${newState.status}`);
    if (newState.status === VoiceConnectionStatus.Destroyed) {
      destroyManager(guild.id, false, `Disconnected from **${voiceChannel.name}**`);
    }
  });
  connection.on("error", (err) => console.error("[voice] connection error:", err));

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    console.error("[bot] Reconnect failed:", err);
    connection.destroy();
    await status(textChannel, `Failed to reconnect to **${voiceChannel.name}**`);
    return;
  }

  const manager = new VoiceManager(connection, textChannel);
  managers.set(guild.id, manager);

  for (const [, m] of voiceChannel.members) {
    if (!m.user.bot) manager.subscribe(m);
  }

  await status(textChannel, `Reconnected to **${voiceChannel.name}**`);
  console.log(`[bot] Reconnected to ${voiceChannel.name} in ${guild.name}`);
}

client.login(process.env.DISCORD_TOKEN);
