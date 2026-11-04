"use server"

import type {
    PlaylistData,
    PlaylistListResponse,
    AddPlaylistTrackBody,
    AddPlaylistTrackFromQueryBody,
} from "@/types/web"
import { musicApi } from "@/server/music-api"

export async function getPlaylistsAction() {
    return musicApi<PlaylistListResponse>("/api/playlists")
}
export async function getPlaylistAction(playlistId: number) {
    return musicApi<PlaylistData>(`/api/playlists/${playlistId}`)
}
export async function createPlaylistAction(name: string) {
    return musicApi<PlaylistData>("/api/playlists", "POST", { name })
}
export async function renamePlaylistAction(playlistId: number, name: string) {
    return musicApi<PlaylistData>(`/api/playlists/${playlistId}`, "PATCH", { name })
}
export async function deletePlaylistAction(playlistId: number) {
    return musicApi<unknown>(`/api/playlists/${playlistId}`, "DELETE")
}
export async function addTrackToPlaylistAction(playlistId: number, track: AddPlaylistTrackBody) {
    return musicApi<PlaylistData>(`/api/playlists/${playlistId}/tracks`, "POST", {
        query: track.uri,
    })
}
export async function addTrackFromQueryToPlaylistAction(
    playlistId: number,
    body: AddPlaylistTrackFromQueryBody
) {
    return musicApi<PlaylistData>(`/api/playlists/${playlistId}/tracks/from-query`, "POST", {
        query: body.query,
    })
}
export async function removeTrackFromPlaylistAction(playlistId: number, trackId: number) {
    return musicApi<PlaylistData>(`/api/playlists/${playlistId}/tracks/${trackId}`, "DELETE")
}
export async function movePlaylistTrackAction(
    playlistId: number,
    trackId: number,
    newPosition: number
) {
    return musicApi<PlaylistData>(`/api/playlists/${playlistId}/tracks/${trackId}`, "PATCH", {
        to: newPosition,
    })
}
export async function playPlaylistInGuildAction(
    guildId: string,
    playlistId: number,
    revision?: number
) {
    return musicApi<unknown>(`/api/guilds/${guildId}/player/play-playlist`, "POST", {
        playlistId,
        revision,
    })
}
