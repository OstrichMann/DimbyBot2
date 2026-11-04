"use server"

import type { MusicAction, MusicTrack } from "@/shared/music-contract.js"
import type { NativePlayerState, NativeQueueTrack } from "@/shared/fluxer-player-state.js"
import { isFluxerId } from "@/shared/fluxer-user-id.js"
import { musicApi } from "@/server/music-api"

export interface NativeQueueResponse {
    guildId: string
    revision: number
    page: number
    limit: number
    total: number
    totalPages: number
    items: NativeQueueTrack[]
}
export type DashboardMusicAction = Exclude<MusicAction, { type: "enqueue" }>
function validGuild(guildId: string): boolean {
    return isFluxerId(guildId)
}
export async function getMusicStateAction(guildId: string) {
    return validGuild(guildId)
        ? musicApi<NativePlayerState>(`/api/guilds/${guildId}/player`)
        : { ok: false as const, error: "Invalid guild ID" }
}
export async function getMusicQueueAction(guildId: string, page = 1, limit = 100) {
    if (
        !validGuild(guildId) ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
    )
        return { ok: false as const, error: "Invalid queue page" }
    return musicApi<NativeQueueResponse>(`/api/guilds/${guildId}/queue?page=${page}&limit=${limit}`)
}
export async function searchMusicAction(guildId: string, query: string) {
    if (!validGuild(guildId)) return { ok: false as const, error: "Invalid guild ID" }
    return musicApi<{ tracks: MusicTrack[] }>(
        `/api/guilds/${guildId}/search?${new URLSearchParams({ q: query })}`
    )
}
export async function playMusicAction(guildId: string, query: string, revision?: number) {
    if (!validGuild(guildId)) return { ok: false as const, error: "Invalid guild ID" }
    return musicApi<NativePlayerState>(`/api/guilds/${guildId}/player/play`, "POST", {
        query,
        revision,
    })
}
export async function mutateMusicAction(
    guildId: string,
    action: DashboardMusicAction,
    revision?: number
) {
    if (!validGuild(guildId)) return { ok: false as const, error: "Invalid guild ID" }
    if (action.type === "play") return playMusicAction(guildId, action.query, revision)
    if (action.type === "remove" || action.type === "move")
        return musicApi<NativePlayerState>(
            `/api/guilds/${guildId}/queue/${encodeURIComponent(action.entryId)}`,
            action.type === "remove" ? "DELETE" : "PATCH",
            { ...(action.type === "move" ? { toIndex: action.toIndex } : {}), revision }
        )
    if (action.type === "clear")
        return musicApi<NativePlayerState>(`/api/guilds/${guildId}/queue`, "DELETE", { revision })
    const { type, ...fields } = action
    return musicApi<NativePlayerState>(`/api/guilds/${guildId}/player`, "POST", {
        action: type,
        ...fields,
        revision,
    })
}
