import { randomUUID } from "node:crypto"
import { isBlockedUserMediaUrl } from "../../util/userMediaUrl.js"
import { youtubeVideoIdFromUri } from "../../util/youtubeCompanionPlayback.js"
import type { CompanionSource } from "./companionSource.js"
import type { LavalinkSearch, MusicSearchResult } from "./lavalinkSearch.js"
import type { PublicMediaFetcher } from "./mediaFetch.js"
import type { MusicTrack, PreparedSource } from "./types.js"

interface ResolverDependencies {
    metadata: LavalinkSearch
    companion: Pick<CompanionSource, "prepare">
    media: Pick<PublicMediaFetcher, "open">
}

/** Separates searchable catalog identity from the short-lived source that actually produces audio. */
export class SourceResolver {
    constructor(private readonly dependencies: ResolverDependencies) {}
    async search(query: string, requesterId: string, signal: AbortSignal): Promise<MusicTrack[]> {
        return (await this.load(query, requesterId, signal)).tracks
    }
    async load(
        query: string,
        requesterId: string,
        signal: AbortSignal
    ): Promise<MusicSearchResult> {
        signal.throwIfAborted()
        const text = query.trim()
        if (
            !text ||
            text.length > 2048 ||
            /^(?:file|local|link|uri|ftp|icy):/i.test(text) ||
            isBlockedUserMediaUrl(text)
        )
            throw new Error("That URL or query isn't allowed")
        if (/^https?:\/\//i.test(text)) {
            const url = new URL(text)
            if (url.username || url.password) throw new Error("That URL isn't allowed")
            const videoId = youtubeVideoIdFromUri(text)
            if (videoId)
                return this.dependencies.metadata.load(
                    `https://www.youtube.com/watch?v=${videoId}`,
                    requesterId,
                    signal
                )
            const spotify =
                ["open.spotify.com", "play.spotify.com"].includes(url.hostname) &&
                /^\/(track|album|playlist)\/[A-Za-z0-9]{22}\/?$/.test(url.pathname)
            if (spotify)
                return this.dependencies.metadata.load(
                    `https://open.spotify.com${url.pathname.replace(/\/$/, "")}`,
                    requesterId,
                    signal
                )
            if (
                ["youtube.com", "www.youtube.com", "music.youtube.com"].includes(url.hostname) &&
                url.pathname === "/playlist" &&
                /^[\w-]{1,128}$/.test(url.searchParams.get("list") ?? "")
            )
                return this.dependencies.metadata.load(
                    `https://www.youtube.com/playlist?list=${url.searchParams.get("list")}`,
                    requesterId,
                    signal
                )
            // Arbitrary URLs never reach Lavalink, whose Java HTTP client cannot use our DNS pinning.
            return {
                kind: "track",
                tracks: [
                    {
                        entryId: randomUUID(),
                        source: "http",
                        sourceId: url.href,
                        uri: url.href,
                        title: decodeURIComponent(url.pathname.split("/").at(-1) || "Audio stream"),
                        author: url.hostname,
                        durationMs: 0,
                        isStream: true,
                        thumbnailUrl: null,
                        requesterId,
                    },
                ],
            }
        }
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) throw new Error("That URL isn't allowed")
        return this.dependencies.metadata.load(
            `ytsearch:${text.replace(/^ytsearch:/i, "")}`,
            requesterId,
            signal
        )
    }
    async prepare(track: MusicTrack, signal: AbortSignal): Promise<PreparedSource> {
        signal.throwIfAborted()
        if (["youtube", "youtubemusic"].includes(track.source)) {
            const videoId = youtubeVideoIdFromUri(track.uri)
            if (!videoId) throw new Error("Invalid YouTube source")
            return this.dependencies.companion.prepare(videoId, signal)
        }
        if (track.source === "spotify") {
            const matches = await this.dependencies.metadata.load(
                `ytsearch:${track.author} - ${track.title} audio`,
                track.requesterId,
                signal
            )
            const hit = matches.tracks.find((item) =>
                ["youtube", "youtubemusic"].includes(item.source)
            )
            if (!hit) throw new Error("No playable YouTube match for this catalog track")
            return this.prepare(hit, signal)
        }
        if (track.source === "http") {
            const lifetime = new AbortController(),
                combined = AbortSignal.any([signal, lifetime.signal])
            const response = await this.dependencies.media.open(track.uri, combined)
            return {
                input: response.body,
                durationMs: track.durationMs > 0 ? track.durationMs : null,
                playbackUrl: track.uri,
                seekable: !track.isStream,
                close: async () => {
                    lifetime.abort()
                    response.close()
                },
            }
        }
        throw new Error("This music source is not supported yet")
    }
}
