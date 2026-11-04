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
