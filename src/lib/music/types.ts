export type { MusicTrack } from "../../shared/music-contract.js"
import type { VoiceGrant } from "../fluxer/voice.js"

/** A short-lived, cancellable byte source; URLs and credentials never enter FFmpeg arguments. */
export interface PreparedSource {
    input: AsyncIterable<Uint8Array>
    durationMs: number | null
    playbackUrl: string
    seekable: boolean
    close(): Promise<void>
}

export interface MusicTransport {
    connect(grant: VoiceGrant, signal: AbortSignal): Promise<void>
    play(source: PreparedSource, offsetMs: number, signal: AbortSignal): Promise<void>
    pause(): Promise<void>
    resume(): Promise<void>
    setVolume(percent: number): void
    positionMs(): number
    stop(): Promise<void>
    disconnect(): Promise<void>
}

/** Transport loss is recoverable by resuming; it must not be treated as an invalid audio source. */
export class MusicTransportDisconnectedError extends Error {
    constructor() {
        super("Voice transport disconnected")
        this.name = "MusicTransportDisconnectedError"
    }
}
