export type { MusicTrack } from "../../shared/music-contract.js"

/** A short-lived, cancellable byte source; URLs and credentials never enter FFmpeg arguments. */
export interface PreparedSource {
    input: AsyncIterable<Uint8Array>
    durationMs: number | null
    playbackUrl: string
    seekable: boolean
    close(): Promise<void>
}
