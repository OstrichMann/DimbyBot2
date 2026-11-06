import type { MusicService } from "../lib/music/musicService.js"
import { MusicError } from "../lib/music/musicService.js"
import { MusicAccessError, type FluxerAccess } from "../lib/fluxer/access.js"
import type { PlaylistAction, PlaylistService } from "../lib/music/playlistService.js"
import type { SourceResolver } from "../lib/music/sourceResolver.js"
import type { AuthenticatedActor } from "../shared/fluxer-session.js"
import { isFluxerId } from "../shared/fluxer-user-id.js"
import { FluxerReauthRequiredError } from "../shared/fluxer-oauth.js"
import type { MusicAction } from "../shared/music-contract.js"
import {
    nativePlayerState,
    nativeTrackSummary,
    type MusicViewer,
} from "../shared/fluxer-player-state.js"

export interface MusicHttpDependencies {
    music: Pick<MusicService, "execute" | "snapshot" | "subscribe">
    playlists: Pick<PlaylistService, "execute">
    access: Pick<FluxerAccess, "authorizeMusic">
    resolver: Pick<SourceResolver, "search">
    controlChannel(guildId: string): string | null
    viewer(guildId: string, userId: string): MusicViewer | Promise<MusicViewer>
    guilds(actor: AuthenticatedActor): Promise<unknown>
    voiceContext(actor: AuthenticatedActor): Promise<unknown>
}
export interface MusicHttpRequest {
    method: string
    path: string
    body?: unknown
}
export interface MusicHttpResponse {
    status: number
    body: unknown
}
function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
}
function text(value: unknown): string {
    return typeof value === "string" ? value : ""
}
function positive(value: unknown): number {
    const number = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
        throw new MusicError(400, "Invalid position or playlist ID")
    return number
}
function ok(data: unknown): MusicHttpResponse {
    return { status: 200, body: { ok: true, data } }
}
function fail(status: number, message: string): MusicHttpResponse {
    return { status, body: { ok: false, error: { error: message } } }
}
function playerAction(body: Record<string, unknown>): MusicAction {
    switch (body.action) {
        case "pause":
        case "resume":
        case "skip":
        case "stop":
        case "leave":
        case "clear":
        case "shuffle":
            return { type: body.action }
        case "seek":
            return { type: "seek", positionMs: body.positionMs as number }
        case "volume":
            return { type: "volume", percent: body.percent as number }
        case "loop":
            return { type: "loop", mode: body.mode as "off" | "track" | "queue" }
        default:
            throw new MusicError(400, "Unknown music action")
    }
}

/** Native API boundary accepts identity only from a verified server session. */
export async function handleMusicRequest(
    actor: AuthenticatedActor | null,
    request: MusicHttpRequest,
    deps: MusicHttpDependencies
): Promise<MusicHttpResponse> {
    if (!actor || actor.expiresAt <= Date.now()) return fail(401, "Sign in with Fluxer")
    const url = new URL(request.path, "http://bot.internal"),
        method = request.method.toUpperCase(),
        body = object(request.body)
    try {
        if (/^\/api\/(?:admin|downloads|alerts|countdowns)(?:\/|$)/.test(url.pathname))
            return fail(503, "This feature is unavailable in the Fluxer music release")
        if (method === "GET" && url.pathname === "/api/guilds") return ok(await deps.guilds(actor))
        if (method === "GET" && url.pathname === "/api/guilds/voice-context")
            return ok(await deps.voiceContext(actor))
        const playlistPath =
            /^\/api\/playlists(?:\/([^/]+))?(?:\/tracks(?:\/([^/]+))?(?:\/(move|from-query))?)?$/.exec(
                url.pathname
            )
        if (playlistPath) {
            const playlist = playlistPath[1] ? positive(playlistPath[1]) : undefined
            let action: PlaylistAction
            if (!playlist) {
                if (method === "GET") action = { type: "list" }
                else if (method === "POST") action = { type: "create", name: text(body.name) }
                else return fail(404, "Route not found")
            } else if (!url.pathname.includes("/tracks")) {
                if (method === "GET") action = { type: "view", playlist }
                else if (method === "DELETE") action = { type: "delete", playlist }
                else if (method === "PATCH")
                    action = { type: "rename", playlist, name: text(body.name) }
                else return fail(404, "Route not found")
            } else if (method === "DELETE")
                action = { type: "remove", playlist, trackId: positive(playlistPath[2]) }
            else if (method === "PATCH")
                action = {
                    type: "move",
                    playlist,
                    trackId: positive(playlistPath[2] ?? body.trackId),
                    to: positive(body.to ?? body.newPosition),
                }
            else if (method === "POST") action = { type: "add", playlist, query: text(body.query) }
            else return fail(404, "Route not found")
            const result = await deps.playlists.execute(actor.userId, action)
            return ok(
                result.kind === "list"
                    ? { playlists: result.playlists }
                    : result.kind === "playlist"
                      ? result.playlist
                      : result
            )
        }
        const route =
            /^\/api\/guilds\/([^/]+)\/(player(?:\/(play|play-playlist))?|queue(?:\/([^/]+))?|search|dashboard-permissions)$/.exec(
                url.pathname
            )
        if (!route) return fail(404, "Route not found")
        const guildId = route[1]
        if (!isFluxerId(guildId)) return fail(400, "Invalid guild ID")
        await deps.access.authorizeMusic({ userId: actor.userId, guildId }, "view")
        const state = async () =>
            nativePlayerState(
                deps.music.snapshot(guildId),
                await deps.viewer(guildId, actor.userId)
            )
        if (method === "GET") {
            if (route[2] === "player") return ok(await state())
            if (route[2] === "queue") {
                const page = url.searchParams.has("page")
                    ? positive(url.searchParams.get("page"))
                    : 1
                const limit = Math.min(
                    100,
                    url.searchParams.has("limit") ? positive(url.searchParams.get("limit")) : 25
                )
                const snapshot = deps.music.snapshot(guildId)
                return ok({
                    guildId,
                    revision: snapshot.revision,
                    page,
                    limit,
                    total: snapshot.queue.length,
                    totalPages: Math.ceil(snapshot.queue.length / limit),
                    items: snapshot.queue
                        .slice((page - 1) * limit, page * limit)
                        .map(nativeTrackSummary),
                })
            }
            if (route[2] === "search") {
                const query = url.searchParams.get("q") ?? ""
                if (!query.trim() || query.length > 2048) return fail(400, "Enter a music query")
                return ok({
                    tracks: await deps.resolver.search(
                        query,
                        actor.userId,
                        AbortSignal.timeout(15000)
                    ),
                })
            }
            if (route[2] === "dashboard-permissions")
                return ok({
                    memberResolved: true,
                    primaryPermissions: [
                        "VIEW_PLAYER",
                        ...((await deps.viewer(guildId, actor.userId)).canQueueTracks
                            ? ["MANAGE_QUEUE", "CONTROL_PLAYBACK"]
                            : []),
                    ],
                    oauthPermissions: [],
                    fluxerUserId: actor.userId,
                })
            return fail(404, "Route not found")
        }
        let action: MusicAction
        if (method === "POST" && route[2] === "player/play")
            action = {
                type: "play",
                query: text(body.query),
                ...(body.voiceChannelId !== undefined
                    ? { voiceChannelId: text(body.voiceChannelId) }
                    : {}),
            }
        else if (method === "POST" && route[2] === "player/play-playlist") {
            const result = await deps.playlists.execute(actor.userId, {
                type: "enqueue",
                playlist: positive(body.playlistId),
            })
            if (result.kind !== "enqueue") throw new MusicError(400, "Choose a playlist")
            action = { type: "enqueue", tracks: result.tracks }
        } else if (method === "POST" && route[2] === "player") action = playerAction(body)
        else if (method === "POST" && route[2] === "queue")
            action = { type: "play", query: text(body.query) }
        else if (method === "DELETE" && route[2] === "queue") action = { type: "clear" }
        else if (method === "DELETE" && route[4])
            action = { type: "remove", entryId: decodeURIComponent(route[4]) }
        else if (method === "PATCH" && route[4])
            action = {
                type: "move",
                entryId: decodeURIComponent(route[4]),
                toIndex: body.toIndex as number,
            }
        else return fail(404, "Route not found")
        const textChannelId =
            deps.controlChannel(guildId) ?? deps.music.snapshot(guildId).textChannelId
        if (!textChannelId) return fail(400, "Configure a music control channel first")
        await deps.music.execute({ userId: actor.userId, guildId, textChannelId }, action, {
            expectedRevision: body.revision as number | undefined,
        })
        return ok(await state())
    } catch (error) {
        if (
            error instanceof MusicError ||
            error instanceof MusicAccessError ||
            error instanceof FluxerReauthRequiredError
        )
            return fail(error.status, error.message)
        return fail(503, "Music request unavailable")
    }
}
