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
  ChannelType,
} from "discord.js";
import { config } from "./config";
import { clearState, loadState, saveState, type VCEntry, type VCState } from "./persistence";
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
  const notices = [...managers.entries()].map(([key, manager]) =>
    status(manager.textChannel, "Process stopped").then(() => {
      manager.destroy();
      managers.delete(key);
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

// Active VoiceManager keyed by "guildId:channelId" to support multiple VCs per guild
const managers = new Map<string, VoiceManager>();

function managerKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function managersForGuild(guildId: string): [string, VoiceManager][] {
  return [...managers.entries()].filter(([key]) => key.startsWith(`${guildId}:`));
}

async function persistAllState() {
  const state: VCState = [...managers.entries()].map(([key, manager]) => {
    const [guildId, channelId] = key.split(":") as [string, string];
    return {
      guildId,
      voiceChannelId: channelId,
      textChannelId: manager.textChannel.id,
      channelConfig: manager.channelConfig,
    } satisfies VCEntry;
  });
  if (state.length === 0) {
    await clearState();
  } else {
    await saveState(state);
  }
}

async function status(channel: TextChannel, msg: string) {
  await channel.send(`*${msg}*`).catch(() => {});
}

function destroyManager(key: string, persist = true, reason?: string) {
  const manager = managers.get(key);
  if (manager && reason) {
    status(manager.textChannel, reason).catch(() => {});
  }
  manager?.destroy();
  managers.delete(key);
  if (persist) persistAllState().catch(console.error);
}

// ── Slash command definitions ────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your voice channel and start transcribing")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Text channel to post transcriptions in (default: #vc-text or current channel)")
    ),

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
    )
    ,
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

  const guildId = interaction.guildId!;
  const key = managerKey(guildId, voiceChannel.id);

  if (managers.has(key)) {
    const botInVoice = interaction.guild?.members.me?.voice.channelId;
    if (botInVoice === voiceChannel.id) {
      await interaction.reply({ content: "Already transcribing in that channel.", flags: MessageFlags.Ephemeral });
      return;
    }
    // Stale manager — bot is no longer in that voice channel, clean up and allow rejoin
    destroyManager(key, false);
  }

  const guild = interaction.guild!;
  const textChannel =
    (interaction.options.getChannel("channel") as TextChannel | null) ??
    (guild.channels.cache.find(
      (c) => c.name === "vc-text" && c.type === ChannelType.GuildText
    ) as TextChannel | undefined) ??
    (interaction.channel as TextChannel);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  connection.on("error", (err) => {
    console.error("[voice] connection error:", err);
  });
  connection.on("stateChange", async (oldState, newState) => {
    console.log(`[voice] ${oldState.status} → ${newState.status}`);
    if (newState.status === VoiceConnectionStatus.Destroyed) {
      destroyManager(key, true, `Disconnected from **${voiceChannel.name}**`);
    } else if (newState.status === VoiceConnectionStatus.Disconnected) {
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      } catch {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          connection.destroy();
        }
      }
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
  managers.set(key, manager);

  for (const [, m] of voiceChannel.members) {
    if (!m.user.bot) manager.subscribe(m);
  }

  await persistAllState();
  await status(textChannel, `Now transcribing **${voiceChannel.name}**`);
  await interaction.editReply(`Transcribing **${voiceChannel.name}** → ${textChannel}`);
  console.log(`[bot] Joined ${voiceChannel.name} in ${guild.name}`);
}

async function handleLeave(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const member = interaction.member as GuildMember;
  const voiceChannelId = member.voice.channelId;

  // If the invoking user is in a channel we're transcribing, leave that one
  if (voiceChannelId) {
    const key = managerKey(guildId, voiceChannelId);
    if (managers.has(key)) {
      destroyManager(key, true, "Stopped transcribing");
      await interaction.reply({ content: "Left and stopped transcribing.", flags: MessageFlags.Ephemeral });
      return;
    }
  }

  // Otherwise leave all VCs in this guild
  const guildManagers = managersForGuild(guildId);
  if (guildManagers.length === 0) {
    await interaction.reply({ content: "Not currently transcribing.", flags: MessageFlags.Ephemeral });
    return;
  }
  for (const [key] of guildManagers) {
    destroyManager(key, false, "Stopped transcribing");
  }
  await persistAllState();
  await interaction.reply({ content: `Left and stopped transcribing ${guildManagers.length} channel(s).`, flags: MessageFlags.Ephemeral });
}

async function handleConfig(interaction: ChatInputCommandInteraction) {
  const flush = interaction.options.getInteger("flush_interval");
  const silence = interaction.options.getInteger("silence_finalize");

  if (flush) config.flushIntervalMs = flush;
  if (silence) config.silenceFinalizeMs = silence;

  // Apply to the invoker's current VC manager if one exists, and persist
  const guildId = interaction.guildId!;
  const member = interaction.member as GuildMember;
  const voiceChannelId = member.voice.channelId;
  const targetKey = voiceChannelId ? managerKey(guildId, voiceChannelId) : null;
  const targetManager = targetKey ? managers.get(targetKey) : null;

  if (targetManager) {
    if (flush) targetManager.channelConfig.flushIntervalMs = flush;
    if (silence) targetManager.channelConfig.silenceFinalizeMs = silence;
    await persistAllState();
  }

  const cfg = targetManager?.channelConfig ?? config;
  await interaction.reply({
    content: [
      `**STT config updated${targetManager ? " for your current channel" : " (global defaults)"}:**`,
      `• Flush interval: **${cfg.flushIntervalMs}ms**`,
      `• Silence finalize: **${cfg.silenceFinalizeMs}ms**`,
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

  // Member joined a channel we're transcribing
  if (newState.channelId && newState.member) {
    const joinKey = managerKey(guildId, newState.channelId);
    const joinManager = managers.get(joinKey);
    if (joinManager) {
      joinManager.subscribe(newState.member);
    }
  }

  // Member left a channel we're transcribing
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    const leaveKey = managerKey(guildId, oldState.channelId);
    const leaveManager = managers.get(leaveKey);
    if (leaveManager) {
      leaveManager.unsubscribe(oldState.id);

      const channel = oldState.channel;
      const remaining = channel?.members.filter((m) => !m.user.bot).size ?? 0;
      if (remaining === 0) {
        console.log(`[bot] Everyone left ${channel?.name}, auto-leaving`);
        destroyManager(leaveKey, true, `Everyone left **${channel?.name}**, stopped transcribing`);
      }
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
  if (!state || state.length === 0) return;

  console.log(`[bot] Reconnecting to ${state.length} saved VC(s)...`);

  for (const entry of state) {
    const guild = client.guilds.cache.get(entry.guildId);
    const voiceChannel = guild?.channels.cache.get(entry.voiceChannelId);
    const textChannel = guild?.channels.cache.get(entry.textChannelId) as TextChannel | undefined;

    if (!guild || !voiceChannel?.isVoiceBased() || !textChannel) {
      console.warn(`[bot] Saved VC state for guild ${entry.guildId} / channel ${entry.voiceChannelId} is stale, skipping`);
      continue;
    }

    const key = managerKey(guild.id, voiceChannel.id);

    await status(textChannel, `Reconnecting to **${voiceChannel.name}**...`);

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    connection.on("error", (err) => console.error("[voice] connection error:", err));
    connection.on("stateChange", async (oldState, newState) => {
      console.log(`[voice] ${oldState.status} → ${newState.status}`);
      if (newState.status === VoiceConnectionStatus.Destroyed) {
        destroyManager(key, true, `Disconnected from **${voiceChannel.name}**`);
      } else if (newState.status === VoiceConnectionStatus.Disconnected) {
        try {
          await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        } catch {
          if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
            connection.destroy();
          }
        }
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
      console.error("[bot] Reconnect failed:", err);
      connection.destroy();
      await status(textChannel, `Failed to reconnect to **${voiceChannel.name}**`);
      continue;
    }

    const manager = new VoiceManager(connection, textChannel, entry.channelConfig);
    managers.set(key, manager);

    for (const [, m] of voiceChannel.members) {
      if (!m.user.bot) manager.subscribe(m);
    }

    await status(textChannel, `Reconnected to **${voiceChannel.name}**`);
    console.log(`[bot] Reconnected to ${voiceChannel.name} in ${guild.name}`);
  }

  // Re-persist to clean up any stale entries that were skipped
  await persistAllState();
}

client.login(process.env.DISCORD_TOKEN);
