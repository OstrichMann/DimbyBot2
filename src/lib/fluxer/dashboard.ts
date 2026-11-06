import type { GuildListResponse, VoiceContextResponse } from "../../types/web.js"
import type { AuthenticatedActor } from "../../shared/fluxer-session.js"
import type { MusicViewer } from "../../shared/fluxer-player-state.js"
import { isFluxerId } from "../../shared/fluxer-user-id.js"
import type { MusicService } from "../music/musicService.js"
import { MusicAccessError, type FluxerAccess } from "./access.js"
import { fluxerRecord, type FluxerEntities } from "./entities.js"
import type { FluxerOAuthAccounts } from "../../shared/fluxer-oauth-accounts.js"

interface Dependencies {
    entities: FluxerEntities
    music: Pick<MusicService, "snapshot" | "allSnapshots">
    access: Pick<FluxerAccess, "authorizeMusic">
    accounts: Pick<FluxerOAuthAccounts, "accessToken">
    ready(): boolean
    botChannelId(guildId: string): string | null
    endpoints: { api: string; media: string; webapp: string }
    clientId: string
    fetchImpl?: typeof fetch
}

/** OAuth guild pages intersect known Bot membership. Voice and queue access wait until a guild is opened. */
export class FluxerDashboard {
    constructor(private readonly dependencies: Dependencies) {}
    async viewer(guildId: string, userId: string): Promise<MusicViewer> {
        const { entities, access, botChannelId } = this.dependencies
        const channel = botChannelId(guildId)
        const inVoiceWithBot = !!channel && entities.voiceChannelsFor(guildId, userId).has(channel)
        try {
            await access.authorizeMusic({ guildId, userId }, "queue")
            return { inVoiceWithBot, canQueueTracks: true }
        } catch (error) {
            if (error instanceof MusicAccessError && [400, 403].includes(error.status))
                return { inVoiceWithBot, canQueueTracks: false }
            throw error
        }
    }
    async guilds(actor: AuthenticatedActor): Promise<GuildListResponse> {
        const { ready, accounts, endpoints, entities, music } = this.dependencies
        if (!ready()) throw new MusicAccessError(503, "Bot is reconnecting")
        const accessToken = await accounts.accessToken(actor.authUserId)
        const rows: Record<string, unknown>[] = []
        let after = "0"
        for (let page = 0; page < 10; page++) {
            let data: unknown
            try {
                const response = await (this.dependencies.fetchImpl ?? fetch)(
                    `${endpoints.api}/users/@me/guilds?limit=200&after=${after}`,
                    {
                        headers: { Authorization: `Bearer ${accessToken}` },
                        redirect: "error",
                        signal: AbortSignal.timeout(10000),
                    }
                )
                if (!response.ok) throw new Error("Guild list failed")
                data = await response.json()
            } catch {
                throw new MusicAccessError(503, "Fluxer guild discovery unavailable")
            }
            if (!Array.isArray(data) || data.some((value) => !isFluxerId(fluxerRecord(value).id)))
                throw new MusicAccessError(503, "Fluxer guild discovery unavailable")
            rows.push(...data.map(fluxerRecord))
            if (data.length < 200) break
            const next = data.reduce(
                (max: string, row) =>
                    BigInt(fluxerRecord(row).id as string) > BigInt(max)
                        ? (fluxerRecord(row).id as string)
                        : max,
                after
            )
            if (next === after)
                throw new MusicAccessError(503, "Fluxer guild discovery unavailable")
            after = next
            if (page === 9) throw new MusicAccessError(503, "Guild list exceeds supported size")
        }
        const guilds: GuildListResponse["guilds"] = []
        for (const row of rows) {
            const guildId = row.id as string
            const guild = entities.getGuild(guildId)
            if (!guild?.available) continue
            let player: GuildListResponse["guilds"][number]["player"] = null
            try {
                const snapshot = music.snapshot(guildId)
                const channel = this.dependencies.botChannelId(guildId)
                if (snapshot.current || snapshot.connected)
                    player = {
                        status: snapshot.status,
                        botInVoiceChannel: snapshot.connected,
                        inVoiceWithBot:
                            !!channel &&
                            entities.voiceChannelsFor(guildId, actor.userId).has(channel),
                        currentTrackTitle: snapshot.current?.title ?? null,
                        currentTrackAuthor: snapshot.current?.author ?? null,
                        queueCount: snapshot.queue.length,
                    }
            } catch {
                player = null
            }
            guilds.push({
                id: guildId,
                name: typeof row.name === "string" ? row.name : guild.name,
                iconUrl:
                    typeof row.icon === "string" && /^[a-zA-Z0-9_]+$/.test(row.icon)
                        ? `${endpoints.media}/icons/${guildId}/${row.icon}.webp`
                        : null,
                memberCount: null,
                player,
            })
        }
        const invite = new URL(`${endpoints.webapp}/oauth2/authorize`)
        invite.search = new URLSearchParams({
            client_id: this.dependencies.clientId,
            scope: "bot",
            permissions: "3165184",
        }).toString()
        return { guilds, botInviteUrl: invite.href }
    }
    async voiceContext(actor: AuthenticatedActor): Promise<VoiceContextResponse> {
        const { access, music, entities } = this.dependencies
        for (const snapshot of music.allSnapshots()) {
            const guild = entities.getGuild(snapshot.guildId)
            if (
                !snapshot.connected ||
                !guild?.available ||
                !snapshot.voiceChannelId ||
                !entities
                    .voiceChannelsFor(snapshot.guildId, actor.userId)
                    .has(snapshot.voiceChannelId)
            )
                continue
            try {
                await access.authorizeMusic(
                    { userId: actor.userId, guildId: snapshot.guildId },
                    "view"
                )
            } catch (error) {
                if (error instanceof MusicAccessError && error.status === 403) continue
                throw error
            }
            return {
                activeGuild: {
                    guildId: snapshot.guildId,
                    guildName: guild.name,
                    guildIconUrl: null,
                    status: snapshot.status,
                    currentTrackTitle: snapshot.current?.title ?? null,
                },
            }
        }
        return { activeGuild: null }
    }
}
