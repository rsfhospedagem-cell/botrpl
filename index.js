const { 
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  SlashCommandBuilder, 
  MessageFlags
} = require('discord.js');

require('dotenv').config();
const fs = require('fs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

// ══════════════════════════════════════════════════
// CONFIG — ajuste os IDs para a nova liga
// ══════════════════════════════════════════════════

const CONFIG = {
  CHANNELS: {
    CONTRACT_ANNOUNCEMENT: '1491286558383407144',
    FA_ANNOUNCEMENT:       '1491286520882008125',
    SCOUTING_ANNOUNCEMENT: '1491286590348071026',
  },

  ROLES: {
    FA_ROLE:     '1503566634139390095',
    STAFF_ROLES: ['1479993500048036023', '1493788660095520849'],   // quem pode propor contratos e scouting
    TEAM_ROLES: [
  '1492519057260286094',
  '1492518524613300334',
  '1492519386643169441',
  '1492519737127604314',
  '1492520129597280386',
  '1492520363882713239',
  '1492520668015759591',
  '1492520904159268955',
  '1492521278891098213',
  '1492521673541554176',
  '1492521950264692846',
  '1492522173582016683',
  '1492522750672244857',
  '1492524229701402624',
  '1492524423197229096',
  '1492524690734977125'
]
  },

  CONTRACT_EXPIRATION: 24 * 60 * 60 * 1000,
};

const ALLOWED_COMMAND_CHANNEL = '1487541887450480710'; // canal onde /contract e /scouting podem ser usados
const MAX_ROSTER_SIZE = 15;
const RELEASE_CHANNEL = '1493795659613077615';

// ══════════════════════════════════════════════════
// ESTADO
// ══════════════════════════════════════════════════

const windowStatus = {
  contracts: false,  // true = fechada
  freeAgent: false,
};

const pendingContracts = new Map();
const activeContracts  = new Map();
const expirationTimers = new Map();
const CONTRACTS_FILE   = './contratos.json';

// ══════════════════════════════════════════════════
// PERSISTÊNCIA
// ══════════════════════════════════════════════════

function saveContracts() {
  const data = {};
  for (const [id, c] of activeContracts) data[id] = { ...c };
  fs.writeFileSync(CONTRACTS_FILE, JSON.stringify(data, null, 2));
}

function loadContracts() {
  if (!fs.existsSync(CONTRACTS_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(CONTRACTS_FILE, 'utf8'));
    const now  = Date.now();
    for (const [id, c] of Object.entries(data)) {
      const expiresAt = c.expiresAt ? new Date(c.expiresAt).getTime() : null;
      if (expiresAt && expiresAt <= now) { console.log(`[Load] Contrato ${id} expirado.`); continue; }
      activeContracts.set(id, {
        ...c,
        signedAt:  new Date(c.signedAt),
        expiresAt: c.expiresAt ? new Date(c.expiresAt) : null
      });
      if (expiresAt) {
        const remaining = expiresAt - now;
        remaining > 5000 ? setupExpirationTimer(id, c, remaining) : activeContracts.delete(id);
      }
    }
  } catch (err) { console.error('Erro ao carregar contratos:', err); }
}

async function releasePlayer(member) {

  const teamRolesFound = CONFIG.ROLES.TEAM_ROLES.filter(id =>
    member.roles.cache.has(id)
  );

  // remove todos cargos de time
  for (const roleId of teamRolesFound) {
    await member.roles.remove(roleId).catch(() => {});
  }

  // adiciona Free Agent
  await member.roles.add(CONFIG.ROLES.FA_ROLE).catch(() => {});

  // remove contratos ativos
  for (const [id, c] of activeContracts) {
    if (
  c.signee.id === member.id &&
  c.guildId === member.guild.id
) {

      clearTimeout(expirationTimers.get(id));
      expirationTimers.delete(id);

      activeContracts.delete(id);
    }
  }

  saveContracts();

  return teamRolesFound;
}

// ══════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════

function getTeamRosterCount(teamRoleId, guildId) {
  return [...activeContracts.values()].filter(
    c => c.teamRoleId === teamRoleId && c.guildId === guildId
  ).length;
}

function setupExpirationTimer(id, c, time) {
  const timer = setTimeout(async () => {
    activeContracts.delete(id);
    expirationTimers.delete(id);
    saveContracts();

    const guild = client.guilds.cache.get(c.guildId);
    if (!guild) return;
    const member = await guild.members.fetch(c.signee.id).catch(() => null);
    if (member) {
      if (c.teamRoleId) await member.roles.remove(c.teamRoleId).catch(() => {});
      await member.roles.add(CONFIG.ROLES.FA_ROLE).catch(() => {});
    }

    const channel = guild.channels.cache.get(CONFIG.CHANNELS.CONTRACT_ANNOUNCEMENT);
    if (channel) {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xffa500)
            .setTitle('Contrato Expirado')
            .setDescription(`O contrato de **${c.signee.username}** com **${c.teamName}** expirou.`)
            .setTimestamp()
        ]
      });
    }
  }, time);
  expirationTimers.set(id, timer);
}

// ══════════════════════════════════════════════════
// SINCRONIZAÇÃO DE ROSTER POR CARGO
// ══════════════════════════════════════════════════

async function syncRostersFromRoles() {
  console.log('[Sync] Iniciando sincronização...');
  for (const guild of client.guilds.cache.values()) {
    try {
      const members = await guild.members.fetch();
      for (const roleId of CONFIG.ROLES.TEAM_ROLES) {
        const role = guild.roles.cache.get(roleId);
        if (!role) continue;
        for (const member of members.filter(m => m.roles.cache.has(roleId)).values()) {
          const autoId = `AUTO_${guild.id}_${member.id}`;
          const alreadyExists = [...activeContracts.values()].some(
            c => c.signee.id === member.id && c.guildId === guild.id
          );
          if (alreadyExists) continue;
          activeContracts.set(autoId, {
            signee:     { id: member.id, username: member.user.username },
            contractor: { id: 'system', username: 'System' },
            teamName:   role.name,
            teamRoleId: role.id,
            position:   'Unknown',
            role:       'Player',
            guildId:    guild.id,
            signedAt:   new Date(),
            expiresAt:  null,
            automatic:  true
          });
        }
      }
    } catch (err) { console.error(`[Sync] Erro na guild ${guild.id}:`, err); }
  }
  saveContracts();
  console.log('[Sync] Concluída.');
}

// ══════════════════════════════════════════════════
// COMMANDS
// ══════════════════════════════════════════════════

const commands = [

  new SlashCommandBuilder()
    .setName('contract')
    .setDescription('Propor um contrato')
    .addUserOption(opt => opt.setName('jogador').setDescription('Jogador').setRequired(true))
    .addRoleOption(opt => opt.setName('time').setDescription('Cargo do time').setRequired(true))
    .addStringOption(opt => opt.setName('posicao').setDescription('Posição').setRequired(true))
    .addStringOption(opt => opt.setName('role').setDescription('Role').setRequired(true)),

  new SlashCommandBuilder()
  .setName('release')
  .setDescription('Liberar um jogador do time')
  .addUserOption(opt =>
    opt
      .setName('jogador')
      .setDescription('Jogador')
      .setRequired(true)
  ),

  new SlashCommandBuilder()
    .setName('fa')
    .setDescription('Anunciar Free Agent')
    .addStringOption(opt => opt.setName('posicao').setDescription('Posição').setRequired(true))
    .addStringOption(opt => opt.setName('exp').setDescription('Experiência').setRequired(true))
    .addStringOption(opt => opt.setName('plataforma').setDescription('Plataforma').setRequired(true)),

  new SlashCommandBuilder()
    .setName('scouting')
    .setDescription('Recrutar jogador para o time')
    .addStringOption(opt => opt.setName('time').setDescription('Nome do time').setRequired(true))
    .addStringOption(opt => opt.setName('posicao').setDescription('Posição desejada').setRequired(true))
    .addStringOption(opt => opt.setName('sobre').setDescription('Informações adicionais').setRequired(true)),
];

// ══════════════════════════════════════════════════
// CLIENT READY
// ══════════════════════════════════════════════════

client.once(Events.ClientReady, async () => {
  console.log(`Bot logado como ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: 'RPL | Roblox Professional League', type: 0 }], status: 'online' });
  loadContracts();
  await syncRostersFromRoles();
  await client.application.commands.set(commands.map(c => c.toJSON()));
  console.log('Slash Commands registrados.');
});

// ══════════════════════════════════════════════════
// SINCRONIZAÇÃO EM TEMPO REAL
// ══════════════════════════════════════════════════

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guild = newMember.guild;
  for (const roleId of CONFIG.ROLES.TEAM_ROLES) {
    const hadRole = oldMember.roles.cache.has(roleId);
    const hasRole = newMember.roles.cache.has(roleId);

    if (!hadRole && hasRole) {
      const alreadyExists = [...activeContracts.values()].some(
        c => c.signee.id === newMember.id && c.guildId === guild.id
      );
      if (!alreadyExists) {
        const role = guild.roles.cache.get(roleId);
        activeContracts.set(`AUTO_${guild.id}_${newMember.id}`, {
          signee:     { id: newMember.id, username: newMember.user.username },
          contractor: { id: 'system', username: 'System' },
          teamName:   role?.name ?? roleId,
          teamRoleId: roleId,
          position:   'Unknown',
          role:       'Player',
          guildId:    guild.id,
          signedAt:   new Date(),
          expiresAt:  null,
          automatic:  true
        });
        saveContracts();
      }
    }

    if (hadRole && !hasRole) {
      for (const [id, c] of activeContracts) {
        if (c.signee.id === newMember.id && c.guildId === guild.id) {
          clearTimeout(expirationTimers.get(id));
          expirationTimers.delete(id);
          activeContracts.delete(id);
        }
      }
      saveContracts();
    }
  }
});

// ══════════════════════════════════════════════════
// INTERACTIONS
// ══════════════════════════════════════════════════

client.on(Events.InteractionCreate, async interaction => {

  // /CONTRACT
  if (interaction.isChatInputCommand() && interaction.commandName === 'contract') {
    const { member, options, user, guild } = interaction;

    if (!CONFIG.ROLES.STAFF_ROLES.some(id => member.roles.cache.has(id)))
      return interaction.reply({ content: 'Sem permissão.', flags: MessageFlags.Ephemeral });

    if (interaction.channelId !== ALLOWED_COMMAND_CHANNEL)
  return interaction.reply({ content: 'Este comando só pode ser usado no canal autorizado.', flags: MessageFlags.Ephemeral });

    if (windowStatus.contracts)
      return interaction.reply({ content: '🔒 A **janela de contratos** está fechada.', flags: MessageFlags.Ephemeral });

    const targetUser  = options.getUser('jogador');
    const teamRole    = options.getRole('time');
    const rosterCount = getTeamRosterCount(teamRole.id, guild.id);

    if (rosterCount >= MAX_ROSTER_SIZE)
      return interaction.reply({ content: `O time **${teamRole.name}** já atingiu o limite de **${MAX_ROSTER_SIZE} jogadores**.`, flags: MessageFlags.Ephemeral });

    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember)
      return interaction.reply({ content: 'Jogador não encontrado no servidor.', flags: MessageFlags.Ephemeral });

    const currentTeamRoleId = CONFIG.ROLES.TEAM_ROLES.find(id => targetMember.roles.cache.has(id));
    if (currentTeamRoleId) {
      const currentTeamRole = guild.roles.cache.get(currentTeamRoleId);
      return interaction.reply({
        content: `<@${targetUser.id}> já faz parte de **${currentTeamRole?.name ?? 'um time'}** e não pode receber propostas.`,
        flags: MessageFlags.Ephemeral
      });
    }

    const contractId = `C_${Date.now()}_${user.id}`;
    pendingContracts.set(contractId, {
      signee:     { id: targetUser.id, username: targetUser.username },
      contractor: { id: user.id, username: user.username },
      teamName:   teamRole.name,
      teamRoleId: teamRole.id,
      position:   options.getString('posicao'),
      role:       options.getString('role'),
      guildId:    guild.id
    });

    const spotsLeft = MAX_ROSTER_SIZE - rosterCount - 1;

    const embed = new EmbedBuilder()
      .setColor('#0d0d0d')
      .setAuthor({ name: `${targetUser.username}, um contrato foi proposto por ${user.username}.`, iconURL: guild.iconURL({ dynamic: true }) })
      .setTitle('Agreement Contract')
      .setDescription('By signing this contract, you commit to representing the Contractor and their team with dedication throughout the tournament.')
      .addFields(
        { name: 'Signee',            value: `<@${targetUser.id}>`,        inline: true },
        { name: 'Contractor',        value: `<@${user.id}>`,              inline: true },
        { name: 'Team',              value: teamRole.name,                inline: true },
        { name: 'Position',          value: options.getString('posicao'), inline: true },
        { name: 'Role',              value: options.getString('role'),    inline: true },
        { name: 'Vagas restantes',   value: `${spotsLeft}/${MAX_ROSTER_SIZE}`, inline: true }
      )
      .setFooter({ text: `${guild.name} - ${new Date().toLocaleDateString('pt-BR')}` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`accept_${contractId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`reject_${contractId}`).setLabel('Reject').setStyle(ButtonStyle.Danger)
    );

    const channel = guild.channels.cache.get(CONFIG.CHANNELS.CONTRACT_ANNOUNCEMENT);
    if (!channel)
      return interaction.reply({ content: 'Canal de contratos não encontrado.', flags: MessageFlags.Ephemeral });

    await channel.send({ content: `<@${targetUser.id}> um contrato foi proposto por <@${user.id}>.`, embeds: [embed], components: [row] });
    return interaction.reply({ content: 'Contrato enviado.', flags: MessageFlags.Ephemeral });
  }

  // /FA
  if (interaction.isChatInputCommand() && interaction.commandName === 'fa') {
    const { options, user, guild } = interaction;

    if (windowStatus.freeAgent)
      return interaction.reply({ content: '🔒 A **janela de Free Agent** está fechada.', flags: MessageFlags.Ephemeral });

    const embed = new EmbedBuilder()
      .setColor(0x000000)
      .setAuthor({ name: 'Free Agent' })
      .setTitle(`${user.username} está disponível para ser contratado!`)
      .setDescription(`<@${user.id}>`)
      .addFields(
        { name: 'Posição',     value: options.getString('posicao')    || 'Não informado', inline: true },
        { name: 'Plataforma',  value: options.getString('plataforma') || 'Não informado', inline: true },
        { name: 'Experiência', value: options.getString('exp')        || 'Não informado', inline: false }
      )
      .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
      .setFooter({ text: `${guild.name} - ${new Date().toLocaleDateString('pt-BR')}` })
      .setTimestamp();

    const channel = guild.channels.cache.get(CONFIG.CHANNELS.FA_ANNOUNCEMENT);
    if (!channel)
      return interaction.reply({ content: 'Canal de Free Agent não encontrado.', flags: MessageFlags.Ephemeral });

    await channel.send({ embeds: [embed] });
    return interaction.reply({ content: 'Free Agent anunciado com sucesso!', flags: MessageFlags.Ephemeral });
  }

  // /SCOUTING
  if (interaction.isChatInputCommand() && interaction.commandName === 'scouting') {
    const { member, options, user, guild } = interaction;

    if (!CONFIG.ROLES.STAFF_ROLES.some(id => member.roles.cache.has(id)))
      return interaction.reply({ content: 'Apenas managers podem usar este comando.', flags: MessageFlags.Ephemeral });

    const channel = guild.channels.cache.get(CONFIG.CHANNELS.SCOUTING_ANNOUNCEMENT);
    if (!channel)
      return interaction.reply({ content: 'Canal de scouting não encontrado.', flags: MessageFlags.Ephemeral });

    const embed = new EmbedBuilder()
      .setColor(0x000000)
      .setAuthor({ name: 'Scouting', iconURL: guild.iconURL({ dynamic: true }) })
      .setTitle(`${user.username} está recrutando!`)
      .setDescription(`<@${user.id}> está em busca de um jogador para o seu time.`)
      .addFields(
        { name: 'Time',    value: options.getString('time'),    inline: true },
        { name: 'Posição', value: options.getString('posicao'), inline: true },
        { name: 'Sobre',   value: options.getString('sobre'),   inline: false }
      )
      .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
      .setFooter({ text: `${guild.name} - ${new Date().toLocaleDateString('pt-BR')}` })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
    return interaction.reply({ content: 'Scouting anunciado com sucesso!', flags: MessageFlags.Ephemeral });
  }

  // Botões Accept / Reject

  // /RELEASE
if (interaction.isChatInputCommand() && interaction.commandName === 'release') {

  const { member, options, guild } = interaction;

  if (interaction.channelId !== ALLOWED_COMMAND_CHANNEL)
  return interaction.reply({
    content: 'Este comando só pode ser usado no canal autorizado.',
    flags: MessageFlags.Ephemeral
  });

  // apenas staff
  if (!CONFIG.ROLES.STAFF_ROLES.some(id => member.roles.cache.has(id))) {
    return interaction.reply({
      content: 'Apenas staff pode usar este comando.',
      flags: MessageFlags.Ephemeral
    });
  }

  const targetUser = options.getUser('jogador');

  const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

  if (!targetMember) {
    return interaction.reply({
      content: 'Jogador nao encontrado.',
      flags: MessageFlags.Ephemeral
    });
  }

  // verifica se está em time
  const hasTeamRole = CONFIG.ROLES.TEAM_ROLES.some(id =>
    targetMember.roles.cache.has(id)
  );

  if (!hasTeamRole) {
    return interaction.reply({
      content: 'Esse jogador nao esta em nenhum time.',
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  // pega nome do time antes de remover
  const oldTeamRoleId = CONFIG.ROLES.TEAM_ROLES.find(id =>
    targetMember.roles.cache.has(id)
  );

  const oldTeamRole = guild.roles.cache.get(oldTeamRoleId);

  // release
  await releasePlayer(targetMember);

  // novo roster
  const newRosterCount = getTeamRosterCount(oldTeamRoleId, guild.id);

  // canal de release
  const channel = guild.channels.cache.get(RELEASE_CHANNEL);

  if (channel) {

    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle('Player Released')
      .setDescription(
        `<@${targetUser.id}> foi liberado de **${oldTeamRole?.name || 'Unknown Team'}**`
      )
      .addFields(
        {
          name: 'Jogador',
          value: `<@${targetUser.id}>`,
          inline: true
        },
        {
          name: 'Liberado por',
          value: `<@${member.id}>`,
          inline: true
        },
        {
          name: 'Roster',
          value: `${newRosterCount}/${MAX_ROSTER_SIZE}`,
          inline: true
        }
      )
      .setThumbnail(
        targetUser.displayAvatarURL({ dynamic: true, size: 256 })
      )
      .setFooter({
        text: `${guild.name} - ${new Date().toLocaleDateString('pt-BR')}`
      })
      .setTimestamp();

    await channel.send({
      embeds: [embed]
    });
  }

  return interaction.editReply({
    content: `<@${targetUser.id}> foi liberado com sucesso.`
  });
}

  if (interaction.isButton()) {
    const action     = interaction.customId.startsWith('accept') ? 'accept' : 'reject';
    const contractId = interaction.customId.replace(`${action}_`, '');
    const data       = pendingContracts.get(contractId);

    if (!data) return;

    if (interaction.user.id !== data.signee.id)
      return interaction.reply({ content: 'Esse contrato não é seu.', flags: MessageFlags.Ephemeral });

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('accepted_button').setLabel('Accept').setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId('rejected_button').setLabel('Reject').setStyle(ButtonStyle.Danger).setDisabled(true)
    );

    if (action === 'accept') {
      const rosterCount = getTeamRosterCount(data.teamRoleId, data.guildId);
      if (rosterCount >= MAX_ROSTER_SIZE) {
        pendingContracts.delete(contractId);
        return interaction.update({ content: `Contrato cancelado: **${data.teamName}** já atingiu o limite.`, components: [disabledRow] });
      }

      const member = await interaction.guild.members.fetch(data.signee.id);
      if (CONFIG.ROLES.TEAM_ROLES.some(id => member.roles.cache.has(id))) {
        pendingContracts.delete(contractId);
        return interaction.update({ content: `Contrato cancelado: <@${data.signee.id}> já está em um time.`, components: [disabledRow] });
      }

      activeContracts.set(contractId, { ...data, signedAt: new Date(), expiresAt: null });
      pendingContracts.delete(contractId);
      saveContracts();

      await member.roles.add(data.teamRoleId);
      await member.roles.remove(CONFIG.ROLES.FA_ROLE).catch(() => {});

      const newCount = getTeamRosterCount(data.teamRoleId, data.guildId);

      const acceptedEmbed = new EmbedBuilder()
        .setColor('#00ff88')
        .setTitle('Contract Accepted')
        .setDescription(`<@${data.signee.id}> assinou com **${data.teamName}**`)
        .addFields(
          { name: 'Signee',     value: `<@${data.signee.id}>`,                   inline: true },
          { name: 'Contractor', value: `<@${data.contractor.id}>`,                inline: true },
          { name: 'Team',       value: data.teamName,                             inline: true },
          { name: 'Position',   value: data.position,                             inline: true },
          { name: 'Role',       value: data.role,                                 inline: true },
          { name: 'Roster',     value: `${newCount}/${MAX_ROSTER_SIZE}`,          inline: true },
          { name: 'Signed on',  value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
        )
        .setFooter({ text: `${interaction.guild.name} - ${new Date().toLocaleDateString('pt-BR')}` })
        .setTimestamp();

      return interaction.update({ content: `<@${data.signee.id}> aceitou o contrato!`, embeds: [acceptedEmbed], components: [disabledRow] });
    }

    if (action === 'reject') {
      pendingContracts.delete(contractId);

      const rejectedEmbed = new EmbedBuilder()
        .setColor('#0d0d0d')
        .setTitle('Contract Rejected')
        .setDescription(`<@${data.signee.id}> recusou a proposta de **${data.teamName}**`)
        .addFields(
          { name: 'Signee',      value: `<@${data.signee.id}>`,                   inline: true },
          { name: 'Contractor',  value: `<@${data.contractor.id}>`,                inline: true },
          { name: 'Team',        value: data.teamName,                             inline: true },
          { name: 'Position',    value: data.position,                             inline: true },
          { name: 'Role',        value: data.role,                                 inline: true },
          { name: 'Rejected on', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
        )
        .setFooter({ text: `${interaction.guild.name} - ${new Date().toLocaleDateString('pt-BR')}` })
        .setTimestamp();

      return interaction.update({ content: `<@${data.signee.id}> recusou o contrato.`, embeds: [rejectedEmbed], components: [disabledRow] });
    }
  }
});

client.login(process.env.TOKEN);