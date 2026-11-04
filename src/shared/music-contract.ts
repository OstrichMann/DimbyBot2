/** Queue entry identity is distinct from source identity, so duplicates remain independently editable. */
export interface MusicTrack {
    entryId: string
    source: string
    sourceId: string
    title: string
    author: string
    uri: string
    durationMs: number
    isStream: boolean
    thumbnailUrl: string | null
    requesterId: string
}

export type RepeatMode = "off" | "track" | "queue"
export type MusicAction =
    | { type: "play"; query: string; voiceChannelId?: string }
    | { type: "enqueue"; tracks: MusicTrack[]; voiceChannelId?: string }
    | { type: "pause" | "resume" | "skip" | "stop" | "leave" | "clear" | "shuffle" }
    | { type: "remove"; entryId: string }
    | { type: "move"; entryId: string; toIndex: number }
    | { type: "seek"; positionMs: number }
    | { type: "volume"; percent: number }
    | { type: "loop"; mode: RepeatMode }

export interface MusicSnapshot {
    guildId: string
    voiceChannelId: string | null
    textChannelId: string | null
    revision: number
    connected: boolean
    status: "idle" | "playing" | "paused"
    current: MusicTrack | null
    queue: MusicTrack[]
    positionMs: number
    durationMs: number
    volume: number
    playbackUrl: string | null
    repeatMode: RepeatMode
    lastError: string | null
}

/** Native restart payload stores source identities, never SDK handles, grants or prepared URLs. */
export interface MusicSessionSnapshotV2 {
    version: 2
    volume: number
    repeatMode: RepeatMode
    paused: boolean
    positionMs: number
    current: MusicTrack | null
    queue: MusicTrack[]
}
