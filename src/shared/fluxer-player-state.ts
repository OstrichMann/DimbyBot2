import type { MusicSnapshot, MusicTrack } from "./music-contract.js"

export interface MusicViewer {
    inVoiceWithBot: boolean
    canQueueTracks: boolean
}
export function nativeTrackSummary(track: MusicTrack) {
    return {
        entryId: track.entryId,
        title: track.title,
        author: track.author,
        uri: track.uri,
        durationMs: track.durationMs,
        isStream: track.isStream,
        thumbnailUrl: track.thumbnailUrl,
        requesterId: track.requesterId,
        requesterUsername: null,
        sourceName: track.source,
    }
}
/** Viewer permissions are composed per response, never cached or broadcast as shared player state. */
export function nativePlayerState(snapshot: MusicSnapshot, viewer: MusicViewer) {
    return {
        guildId: snapshot.guildId,
        revision: snapshot.revision,
        hasPlayer: !!snapshot.current || snapshot.connected,
        status: snapshot.status,
        positionMs: snapshot.positionMs,
        loopMode: snapshot.repeatMode,
        autoplay: false,
        volume: snapshot.volume,
        queueCount: snapshot.queue.length,
        ...viewer,
        botInVoiceChannel: snapshot.connected,
        currentTrack: snapshot.current
            ? {
                  ...nativeTrackSummary(snapshot.current),
                  sourceUri: snapshot.current.uri,
                  uri: snapshot.playbackUrl ?? snapshot.current.uri,
                  durationMs: snapshot.durationMs,
              }
            : null,
    }
}
export type NativePlayerState = ReturnType<typeof nativePlayerState>
export type NativeQueueTrack = ReturnType<typeof nativeTrackSummary>
