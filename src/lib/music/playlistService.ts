import { randomUUID } from "node:crypto"
import * as repository from "../../repositories/playlistRepository.js"
import type { PlaylistData, PlaylistSummary, PlaylistTrackInput } from "../../types/index.js"
import type { MusicTrack } from "../../shared/music-contract.js"
import { isFluxerId } from "../../shared/fluxer-user-id.js"
import { youtubeVideoIdFromUri } from "./companionProtocol.js"
import { canonicalMusicTrack } from "./sessionPersistence.js"
import { MusicError } from "./musicService.js"
import type { SourceResolver } from "./sourceResolver.js"

export type PlaylistAction =
    | { type: "list" }
    | { type: "create"; name: string }
    | { type: "view" | "delete" | "enqueue"; playlist: string | number }
    | { type: "rename"; playlist: string | number; name: string }
    | { type: "add"; playlist: string | number; query: string }
    | { type: "addTracks"; playlist: string | number; tracks: MusicTrack[] }
    | { type: "remove"; playlist: string | number; position?: number; trackId?: number }
    | { type: "move"; playlist: string | number; from?: number; trackId?: number; to: number }
export type PlaylistResult =
    | { kind: "list"; playlists: PlaylistSummary[] }
    | { kind: "playlist"; playlist: PlaylistData }
    | { kind: "deleted"; playlistId: number }
    | { kind: "enqueue"; playlist: PlaylistData; tracks: MusicTrack[] }

export interface NativePlaylistRepository {
    list(userId: string): Promise<PlaylistSummary[]>
    get(userId: string, ref: string | number): Promise<PlaylistData | null>
    create(userId: string, name: string): Promise<PlaylistData>
    rename(userId: string, id: number, name: string): Promise<void>
    delete(userId: string, id: number): Promise<void>
    add(userId: string, id: number, tracks: PlaylistTrackInput[]): Promise<void>
    remove(userId: string, id: number, trackId: number): Promise<void>
    move(userId: string, id: number, trackId: number, toPosition: number): Promise<void>
}
const nativeRepository: NativePlaylistRepository = {
    list: repository.getUserPlaylists,
    get: (user, ref) =>
        typeof ref === "number"
            ? repository.getOwnedPlaylistById(user, ref)
            : repository.getPlaylist(user, ref),
    create: repository.createPlaylist,
    rename: repository.renameOwnedPlaylist,
    delete: repository.deletePlaylistById,
    add: async (user, id, tracks) => {
        await repository.addTracksToPlaylist(id, tracks, user)
    },
    remove: (user, id, trackId) => repository.removeTrackFromPlaylistById(id, trackId, user),
    move: (user, id, trackId, to) => repository.movePlaylistTrackById(id, trackId, to, user),
}

function positive(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}
function playlistName(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 100)
        throw new MusicError(400, "Playlist names must be 1–100 characters")
    return value.trim()
}

/** Source identity can be reconstructed locally; saved playlist enqueue never blocks behind N lookups. */
export function playlistTrackToMusic(track: PlaylistTrackInput, userId: string): MusicTrack {
    const youtubeId = youtubeVideoIdFromUri(track.uri)
    const spotifyId =
        /(?:open\.spotify\.com\/track\/|spotify:track:)([A-Za-z0-9]{22})(?:[/?#]|$)/.exec(
            track.uri
        )?.[1]
    const normalized = canonicalMusicTrack({
        entryId: randomUUID(),
        source: youtubeId ? "youtube" : spotifyId ? "spotify" : "http",
        sourceId: youtubeId ?? spotifyId ?? track.uri,
        title: track.title,
        author: track.author,
        uri: track.uri,
        durationMs: track.duration,
        isStream: track.duration <= 0,
        thumbnailUrl: track.thumbnailUrl ?? null,
        requesterId: userId,
    })
    if (!normalized) throw new MusicError(400, "Invalid playlist track")
    return normalized
}

/** Every read is owner-scoped; every write rechecks ownership in its database predicate/transaction. */
export class PlaylistService {
    private readonly repository: NativePlaylistRepository
    constructor(
        private readonly dependencies: {
            resolver: Pick<SourceResolver, "load">
            repository?: NativePlaylistRepository
        }
    ) {
        this.repository = dependencies.repository ?? nativeRepository
    }
    async execute(userId: string, action: PlaylistAction): Promise<PlaylistResult> {
        if (!isFluxerId(userId)) throw new MusicError(400, "Invalid playlist owner")
        try {
            if (action.type === "list")
                return { kind: "list", playlists: await this.repository.list(userId) }
            if (action.type === "create")
                return {
                    kind: "playlist",
                    playlist: await this.repository.create(userId, playlistName(action.name)),
                }
            if (
                (typeof action.playlist !== "string" || !action.playlist.trim()) &&
                !positive(action.playlist)
            )
                throw new MusicError(400, "Choose a playlist")
            const playlist = await this.repository.get(userId, action.playlist)
            if (!playlist || playlist.userId !== userId)
                throw new MusicError(404, "Playlist not found")
            switch (action.type) {
                case "view":
                    return { kind: "playlist", playlist }
                case "delete":
                    await this.repository.delete(userId, playlist.id)
                    return { kind: "deleted", playlistId: playlist.id }
                case "rename":
                    await this.repository.rename(userId, playlist.id, playlistName(action.name))
                    break
                case "enqueue":
                    if (!playlist.tracks.length) throw new MusicError(400, "This playlist is empty")
                    if (playlist.tracks.length > 1000)
                        throw new MusicError(400, "Queue limit is 1000 tracks")
                    return {
                        kind: "enqueue",
                        playlist,
                        tracks: playlist.tracks.map((track) => playlistTrackToMusic(track, userId)),
                    }
                case "add":
                case "addTracks": {
                    let tracks: MusicTrack[]
                    if (action.type === "add") {
                        if (
                            typeof action.query !== "string" ||
                            !action.query.trim() ||
                            action.query.length > 2048
                        )
                            throw new MusicError(400, "Enter a track query or URL")
                        const found = await this.dependencies.resolver.load(
                            action.query,
                            userId,
                            new AbortController().signal
                        )
                        tracks = found.kind === "search" ? found.tracks.slice(0, 1) : found.tracks
                    } else tracks = action.tracks
                    if (
                        !Array.isArray(tracks) ||
                        !tracks.length ||
                        tracks.length + playlist.tracks.length > 1000
                    )
                        throw new MusicError(
                            400,
                            "Choose tracks within the 1000-track playlist limit"
                        )
                    const normalized = tracks.map((track) =>
                        canonicalMusicTrack({ ...track, requesterId: userId })
                    )
                    if (normalized.some((track) => !track))
                        throw new MusicError(400, "Invalid playlist track")
                    await this.repository.add(
                        userId,
                        playlist.id,
                        normalized.map((track) => ({
                            title: track!.title,
                            author: track!.author,
                            uri: track!.uri,
                            duration: track!.durationMs,
                            thumbnailUrl: track!.thumbnailUrl,
                            addedAt: new Date(),
                        }))
                    )
                    break
                }
                case "remove": {
                    if (action.trackId === undefined && !positive(action.position))
                        throw new MusicError(400, "Track positions start at 1")
                    if (action.trackId !== undefined && !positive(action.trackId))
                        throw new MusicError(400, "Invalid track ID")
                    const track =
                        action.trackId !== undefined
                            ? playlist.tracks.find((track) => track.id === action.trackId)
                            : playlist.tracks[action.position! - 1]
                    if (!track) throw new MusicError(404, "Playlist track not found")
                    await this.repository.remove(userId, playlist.id, track.id)
                    break
                }
                case "move": {
                    if (
                        !positive(action.to) ||
                        (action.trackId === undefined && !positive(action.from)) ||
                        (action.trackId !== undefined && !positive(action.trackId))
                    )
                        throw new MusicError(400, "Track positions start at 1")
                    if (action.to > playlist.tracks.length)
                        throw new MusicError(400, "Playlist position is out of range")
                    const track =
                        action.trackId !== undefined
                            ? playlist.tracks.find((track) => track.id === action.trackId)
                            : playlist.tracks[action.from! - 1]
                    if (!track) throw new MusicError(404, "Playlist track not found")
                    await this.repository.move(userId, playlist.id, track.id, action.to)
                    break
                }
                default:
                    throw new MusicError(400, "Unknown playlist action")
            }
            const updated = await this.repository.get(userId, playlist.id)
            if (!updated || updated.userId !== userId)
                throw new MusicError(404, "Playlist not found")
            return { kind: "playlist", playlist: updated }
        } catch (error) {
            if (error instanceof MusicError) throw error
            if (error instanceof repository.PlaylistLimitError)
                throw new MusicError(400, "Playlist limit is 1000 tracks")
            if (
                error instanceof repository.PlaylistNotFoundError ||
                error instanceof repository.PlaylistTrackNotFoundError
            )
                throw new MusicError(404, "Playlist or track not found")
            if (error instanceof repository.PlaylistDuplicateNameError)
                throw new MusicError(409, "A playlist with that name already exists")
            throw new MusicError(503, "Playlist storage is unavailable")
        }
    }
}
