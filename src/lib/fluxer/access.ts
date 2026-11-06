import { isFluxerId } from "../../shared/fluxer-user-id.js"
import {
    fluxerRecord,
    parseFluxerChannel,
    parseFluxerMember,
    parseFluxerRole,
    type FluxerChannel,
    type FluxerEntities,
    type FluxerMember,
    type FluxerRole,
} from "./entities.js"
import { FluxerRestError, type FluxerRest } from "./rest.js"

const ADMIN = 1n << 3n,
    MANAGE_GUILD = 1n << 5n,
    VIEW = 1n << 10n,
    CONNECT = 1n << 20n,
    SPEAK = 1n << 21n
const ALL = (1n << 64n) - 1n
export class MusicAccessError extends Error {
    constructor(
        readonly status: 400 | 403 | 503,
        message: string
    ) {
        super(message)
        this.name = "MusicAccessError"
    }
}
class GuildStateChangedError extends MusicAccessError {
    constructor() {
        super(503, "Guild state changed; retry the action")
    }
}

/** Re-read authority after a join settles; sustained churn still fails closed. */
async function withSettledGuild<T>(check: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await check()
        } catch (error) {
            if (!(error instanceof GuildStateChangedError) || attempt >= 2) throw error
        }
    }
}

export interface MusicAccess {
    guildId: string
    userId: string
    voiceChannelId: string | null
}
interface AccessDependencies {
    rest: Pick<FluxerRest, "request">
    entities: FluxerEntities
    botId: string
    isReady: () => boolean
    botChannelId: (guildId: string) => string | null
}

function effectivePermissions(
    guildId: string,
    ownerId: string,
    member: FluxerMember,
    roles: Map<string, FluxerRole>,
    channel?: FluxerChannel
): bigint {
    if (member.id === ownerId) return ALL
    let permissions = roles.get(guildId)?.permissions
    if (permissions === undefined || member.roles.some((id) => !roles.has(id)))
        throw new MusicAccessError(503, "Guild permissions unavailable")
    for (const id of member.roles) permissions |= roles.get(id)!.permissions
    if (permissions & ADMIN) return ALL
    if (!channel) return permissions
    const apply = (allow: bigint, deny: bigint) => {
        permissions = (permissions & ~deny) | allow
    }
    const everyone = channel.overwrites.find((entry) => entry.type === 0 && entry.id === guildId)
    if (everyone) apply(everyone.allow, everyone.deny)
    let allow = 0n,
        deny = 0n
    for (const overwrite of channel.overwrites)
        if (overwrite.type === 0 && member.roles.includes(overwrite.id)) {
            allow |= overwrite.allow
            deny |= overwrite.deny
        }
    apply(allow, deny)
    const own = channel.overwrites.find((entry) => entry.type === 1 && entry.id === member.id)
    if (own) apply(own.allow, own.deny)
    return permissions
}

/** Fresh membership/role/channel checks are authoritative; Gateway state supplies live voice placement only. */
export class FluxerAccess {
    constructor(private readonly dependencies: AccessDependencies) {}

    /** Restoring paused queues checks Bot authority without inventing a user's voice placement. */
    async verifyBotVoice(guildId: string, channelId: string): Promise<void> {
        return withSettledGuild(() => this.verifyBotVoiceOnce(guildId, channelId))
    }
    private async verifyBotVoiceOnce(guildId: string, channelId: string): Promise<void> {
        const { rest, entities, botId, isReady } = this.dependencies
        if (!isFluxerId(guildId) || !isFluxerId(channelId))
            throw new MusicAccessError(400, "Invalid Fluxer identifier")
        const guild = entities.getGuild(guildId),
            revision = guild?.revision
        if (!isReady() || !guild?.available) throw new MusicAccessError(503, "Guild unavailable")
        try {
            const [guildValue, rolesValue, memberValue, channelValue] = await Promise.all([
                rest.request<unknown>("GET", `/guilds/${guildId}`),
                rest.request<unknown>("GET", `/guilds/${guildId}/roles`),
                rest.request<unknown>("GET", `/guilds/${guildId}/members/${botId}`),
                rest.request<unknown>("GET", `/channels/${channelId}`),
            ])
            const ownerId = fluxerRecord(guildValue).owner_id,
                bot = parseFluxerMember(memberValue),
                channel = parseFluxerChannel(channelValue, guildId)
            if (!isFluxerId(ownerId) || !bot || bot.id !== botId || !Array.isArray(rolesValue))
                throw new MusicAccessError(503, "Guild permissions unavailable")
            if (
                !channel ||
                channel.id !== channelId ||
                channel.guildId !== guildId ||
                fluxerRecord(channelValue).guild_id !== guildId ||
                channel.type !== 2
            )
                throw new MusicAccessError(403, "Voice channel unavailable")
            if (!channel.complete)
                throw new MusicAccessError(503, "Channel permissions unavailable")
            const roles = new Map<string, FluxerRole>()
            for (const value of rolesValue) {
                const role = parseFluxerRole(value)
                if (!role) throw new MusicAccessError(503, "Guild permissions unavailable")
                roles.set(role.id, role)
            }
            const required = VIEW | CONNECT | SPEAK
            if (
                (effectivePermissions(guildId, ownerId, bot, roles, channel) & required) !==
                    required ||
                bot.mute ||
                bot.deaf
            )
                throw new MusicAccessError(403, "Bot voice permission denied")
            if (!isReady() || entities.getGuild(guildId) !== guild || guild.revision !== revision)
                throw new GuildStateChangedError()
        } catch (error) {
            if (error instanceof MusicAccessError) throw error
            if (error instanceof FluxerRestError && [403, 404].includes(error.status))
                throw new MusicAccessError(403, "Bot voice permission denied")
            throw new MusicAccessError(503, "Fluxer permissions unavailable")
        }
    }

    async authorizeMusic(
        actor: { userId: string; guildId: string },
        action: "view" | "queue" | "control" | "configure",
        channelId?: string
    ): Promise<MusicAccess> {
        return withSettledGuild(() => this.authorizeMusicOnce(actor, action, channelId))
    }
    private async authorizeMusicOnce(
        actor: { userId: string; guildId: string },
        action: "view" | "queue" | "control" | "configure",
        channelId?: string
    ): Promise<MusicAccess> {
        const { rest, entities, botId, isReady, botChannelId } = this.dependencies
        if (
            !isFluxerId(actor.userId) ||
            !isFluxerId(actor.guildId) ||
            (channelId !== undefined && !isFluxerId(channelId))
        )
            throw new MusicAccessError(400, "Invalid Fluxer identifier")
        const guild = entities.getGuild(actor.guildId)
        if (!isReady() || !guild?.available)
            throw new MusicAccessError(503, "Guild voice state unavailable")
        const revision = guild.revision
        try {
            const [guildValue, rolesValue, memberValue, botValue] = await Promise.all([
                rest.request<unknown>("GET", `/guilds/${actor.guildId}`),
                rest.request<unknown>("GET", `/guilds/${actor.guildId}/roles`),
                rest.request<unknown>("GET", `/guilds/${actor.guildId}/members/${actor.userId}`),
                rest.request<unknown>("GET", `/guilds/${actor.guildId}/members/${botId}`),
            ])
            const ownerId = fluxerRecord(guildValue).owner_id
            const member = parseFluxerMember(memberValue),
                bot = parseFluxerMember(botValue)
            if (
                !isFluxerId(ownerId) ||
                !Array.isArray(rolesValue) ||
                !member ||
                !bot ||
                member.id !== actor.userId ||
                bot.id !== botId
            )
                throw new MusicAccessError(503, "Guild permissions unavailable")
            const roles = new Map<string, FluxerRole>()
            for (const value of rolesValue) {
                const role = parseFluxerRole(value)
                if (!role) throw new MusicAccessError(503, "Guild permissions unavailable")
                roles.set(role.id, role)
            }
            if (action !== "view") {
                const timeout = fluxerRecord(memberValue).communication_disabled_until
                if (
                    typeof timeout === "string" &&
                    (!Number.isFinite(Date.parse(timeout)) || Date.parse(timeout) > Date.now())
                )
                    throw new MusicAccessError(403, "Membership permissions restrict this action")
            }
            let voiceChannelId = botChannelId(actor.guildId)
            if (action === "configure") {
                if (!(effectivePermissions(actor.guildId, ownerId, member, roles) & MANAGE_GUILD))
                    throw new MusicAccessError(403, "Manage Guild permission required")
                if (channelId) {
                    const value = await rest.request<unknown>("GET", `/channels/${channelId}`)
                    const channel = parseFluxerChannel(value, actor.guildId)
                    const required = VIEW | (1n << 11n) | (1n << 14n)
                    if (
                        !channel ||
                        channel.id !== channelId ||
                        fluxerRecord(value).guild_id !== actor.guildId ||
                        ![0, 5].includes(channel.type)
                    )
                        throw new MusicAccessError(403, "Choose a text channel in this guild")
                    if (!channel.complete)
                        throw new MusicAccessError(503, "Channel permissions unavailable")
                    if (
                        !(
                            effectivePermissions(actor.guildId, ownerId, member, roles, channel) &
                            VIEW
                        ) ||
                        (effectivePermissions(actor.guildId, ownerId, bot, roles, channel) &
                            required) !==
                            required
                    )
                        throw new MusicAccessError(403, "Control channel permission denied")
                }
                voiceChannelId = null
            } else {
                const userChannels = entities.voiceChannelsFor(actor.guildId, actor.userId)
                if (action !== "view") {
                    if (voiceChannelId && !userChannels.has(voiceChannelId))
                        throw new MusicAccessError(403, "Join the bot's voice channel first")
                    if (action === "control" && !voiceChannelId)
                        throw new MusicAccessError(403, "No active voice session")
                    if (!voiceChannelId) {
                        if (channelId) voiceChannelId = channelId
                        else if (userChannels.size === 1) voiceChannelId = [...userChannels][0]
                        else if (userChannels.size > 1)
                            throw new MusicAccessError(400, "Choose a voice channel explicitly")
                        if (!voiceChannelId || !userChannels.has(voiceChannelId))
                            throw new MusicAccessError(403, "Join a voice channel first")
                    } else if (channelId && channelId !== voiceChannelId)
                        throw new MusicAccessError(403, "Use the bot's voice channel")
                }
                if (voiceChannelId) {
                    const value = await rest.request<unknown>("GET", `/channels/${voiceChannelId}`)
                    const channel = parseFluxerChannel(value, actor.guildId)
                    if (
                        fluxerRecord(value).guild_id !== actor.guildId ||
                        !channel ||
                        channel.id !== voiceChannelId ||
                        channel.type !== 2
                    )
                        throw new MusicAccessError(403, "Voice channel permission denied")
                    if (!channel.complete)
                        throw new MusicAccessError(503, "Channel permissions unavailable")
                    const required = action === "view" ? VIEW : VIEW | CONNECT
                    if (
                        (effectivePermissions(actor.guildId, ownerId, member, roles, channel) &
                            required) !==
                        required
                    )
                        throw new MusicAccessError(403, "Voice channel permission denied")
                    if (
                        action !== "view" &&
                        ((effectivePermissions(actor.guildId, ownerId, bot, roles, channel) &
                            (VIEW | CONNECT | SPEAK)) !==
                            (VIEW | CONNECT | SPEAK) ||
                            bot.mute ||
                            bot.deaf)
                    )
                        throw new MusicAccessError(403, "Bot voice permission denied")
                }
            }
            if (
                !isReady() ||
                entities.getGuild(actor.guildId) !== guild ||
                guild.revision !== revision
            )
                throw new GuildStateChangedError()
            return { ...actor, voiceChannelId }
        } catch (error) {
            if (error instanceof MusicAccessError) throw error
            if (error instanceof FluxerRestError && [403, 404].includes(error.status))
                throw new MusicAccessError(403, "Guild membership or permission denied")
            throw new MusicAccessError(503, "Fluxer permissions unavailable")
        }
    }
}
