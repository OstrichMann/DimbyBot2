import type { FluxerDispatch } from "./gateway.js"

export function fluxerRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
}
function id(value: unknown): string | undefined {
    return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) ? value : undefined
}
function bits(value: unknown): bigint | undefined {
    return typeof value === "string" && /^\d+$/.test(value) && value.length <= 30
        ? BigInt(value)
        : undefined
}
export interface FluxerRole {
    id: string
    permissions: bigint
}
export interface FluxerMember {
    id: string
    roles: string[]
    deaf: boolean
    mute: boolean
}
export interface FluxerOverwrite {
    id: string
    type: number
    allow: bigint
    deny: bigint
}
export interface FluxerChannel {
    id: string
    guildId: string
    type: number
    overwrites: FluxerOverwrite[]
    complete: boolean
}
export interface FluxerVoiceState {
    userId: string
    channelId: string
    connectionId: string
    sessionId: string | null
}
export interface FluxerGuild {
    id: string
    name: string
    ownerId: string | undefined
    available: boolean
    revision: number
    roles: Map<string, FluxerRole>
    channels: Map<string, FluxerChannel>
    members: Map<string, FluxerMember>
    voice: Map<string, FluxerVoiceState>
}
export interface FluxerMessage {
    id: string
    guildId: string | null
    channelId: string
    authorId: string
    content: string
    bot: boolean
    webhook: boolean
}

export function normalizeFluxerMessage(value: unknown): FluxerMessage | null {
    const data = fluxerRecord(value),
        author = fluxerRecord(data.author)
    if (!id(data.id) || !id(data.channel_id) || !id(author.id)) return null
    return {
        id: data.id as string,
        guildId: id(data.guild_id) ?? null,
        channelId: data.channel_id as string,
        authorId: author.id as string,
        content: typeof data.content === "string" ? data.content : "",
        bot: author.bot === true,
        webhook: typeof data.webhook_id === "string",
    }
}

export function parseFluxerRole(value: unknown): FluxerRole | null {
    const data = fluxerRecord(value),
        permissions = bits(data.permissions)
    return id(data.id) && permissions !== undefined ? { id: data.id as string, permissions } : null
}
export function parseFluxerMember(value: unknown): FluxerMember | null {
    const data = fluxerRecord(value),
        userId = id(fluxerRecord(data.user).id)
    return userId && Array.isArray(data.roles) && data.roles.every((role) => id(role))
        ? {
              id: userId,
              roles: data.roles as string[],
              deaf: data.deaf === true,
              mute: data.mute === true,
          }
        : null
}
export function parseFluxerChannel(value: unknown, guildId: string): FluxerChannel | null {
    const data = fluxerRecord(value)
    if (!id(data.id) || !Number.isInteger(data.type)) return null
    let complete = Array.isArray(data.permission_overwrites)
    const overwrites: FluxerOverwrite[] = []
    if (Array.isArray(data.permission_overwrites))
        for (const value of data.permission_overwrites) {
            const overwrite = fluxerRecord(value),
                allow = bits(overwrite.allow),
                deny = bits(overwrite.deny)
            if (
                !id(overwrite.id) ||
                ![0, 1].includes(Number(overwrite.type)) ||
                allow === undefined ||
                deny === undefined
            ) {
                complete = false
                continue
            }
            overwrites.push({
                id: overwrite.id as string,
                type: Number(overwrite.type),
                allow,
                deny,
            })
        }
    return { id: data.id as string, guildId, type: Number(data.type), overwrites, complete }
}

/** Gateway cache is deliberately partial: access resolution must fill missing authoritative records. */
export class FluxerEntities {
    private readonly guilds = new Map<string, FluxerGuild>()
    private revision = 0
    getGuild(id: string): FluxerGuild | undefined {
        return this.guilds.get(id)
    }
    voiceChannelsFor(guildId: string, userId: string): ReadonlySet<string> {
        return new Set(
            [...(this.guilds.get(guildId)?.voice.values() ?? [])]
                .filter((state) => state.userId === userId)
                .map((state) => state.channelId)
        )
    }
    apply(event: FluxerDispatch): void {
        const data = fluxerRecord(event.d)
        if (event.t === "READY") {
            this.guilds.clear()
            return
        }
        if (event.t === "GUILD_DELETE") {
            if (id(data.id)) this.guilds.delete(data.id as string)
            return
        }
        if (["GUILD_CREATE", "GUILD_SYNC"].includes(event.t)) {
            const guildId = id(data.id)
            if (!guildId) return
            const properties = fluxerRecord(data.properties)
            const guild: FluxerGuild = {
                id: guildId,
                name: typeof properties.name === "string" ? properties.name : "",
                ownerId: id(properties.owner_id),
                available: data.unavailable !== true,
                revision: ++this.revision,
                roles: new Map(),
                channels: new Map(),
                members: new Map(),
                voice: new Map(),
            }
            this.guilds.set(guildId, guild)
            for (const value of Array.isArray(data.roles) ? data.roles : []) {
                const role = parseFluxerRole(value)
                if (role) guild.roles.set(role.id, role)
            }
            for (const value of Array.isArray(data.channels) ? data.channels : []) {
                const channel = parseFluxerChannel(value, guildId)
                if (channel) guild.channels.set(channel.id, channel)
            }
            for (const value of Array.isArray(data.members) ? data.members : []) {
                const member = parseFluxerMember(value)
                if (member) guild.members.set(member.id, member)
            }
            for (const value of Array.isArray(data.voice_states) ? data.voice_states : [])
                this.apply({
                    t: "VOICE_STATE_UPDATE",
                    d: { ...fluxerRecord(value), guild_id: guildId },
                })
            return
        }
        const guildId = id(data.guild_id) ?? (event.t === "GUILD_UPDATE" ? id(data.id) : undefined)
        const guild = guildId && this.guilds.get(guildId)
        if (!guild) return
        guild.revision = ++this.revision
        if (event.t === "VOICE_STATE_UPDATE") {
            if (typeof data.connection_id !== "string") return
            const userId = id(data.user_id),
                channelId = id(data.channel_id)
            if (!channelId) guild.voice.delete(data.connection_id)
            else if (userId)
                guild.voice.set(data.connection_id, {
                    userId,
                    channelId,
                    connectionId: data.connection_id,
                    sessionId: typeof data.session_id === "string" ? data.session_id : null,
                })
        } else if (event.t.startsWith("GUILD_ROLE_")) {
            if (event.t === "GUILD_ROLE_DELETE") guild.roles.delete(String(data.role_id))
            else
                for (const value of Array.isArray(data.roles) ? data.roles : [data.role]) {
                    const role = parseFluxerRole(value)
                    if (role) guild.roles.set(role.id, role)
                }
        } else if (event.t.startsWith("GUILD_MEMBER_")) {
            const userId = id(fluxerRecord(data.user).id)
            if (event.t === "GUILD_MEMBER_REMOVE" && userId) {
                guild.members.delete(userId)
                for (const [key, state] of guild.voice)
                    if (state.userId === userId) guild.voice.delete(key)
            } else {
                const member = parseFluxerMember(data)
                if (member) guild.members.set(member.id, member)
            }
        } else if (event.t === "CHANNEL_DELETE") {
            guild.channels.delete(String(data.id))
            for (const [key, state] of guild.voice)
                if (state.channelId === data.id) guild.voice.delete(key)
        } else if (event.t.startsWith("CHANNEL_")) {
            for (const value of Array.isArray(data.channels) ? data.channels : [data]) {
                const channel = parseFluxerChannel(value, guild.id)
                if (channel) guild.channels.set(channel.id, channel)
            }
        } else if (event.t === "GUILD_UPDATE") {
            const properties = fluxerRecord(data.properties ?? data)
            if (typeof properties.name === "string") guild.name = properties.name
            if (id(properties.owner_id)) guild.ownerId = properties.owner_id as string
        }
    }
}
