import { randomUUID } from "node:crypto"
import { fluxerRecord } from "../fluxer/entities.js"
import { thumbnailUrlFromUri } from "../../shared/youtube-thumbnail.js"
import type { MusicTrack } from "./types.js"

export interface MusicSearchResult {
    kind: "track" | "playlist" | "search" | "empty"
    tracks: MusicTrack[]
}
interface SearchConfig {
    origin: string
    password: string
    fetchImpl?: typeof fetch
}

/** Lavalink is used only for metadata; no session, queue, voice connection or encoded track escapes. */
export class LavalinkSearch {
    constructor(private readonly config: SearchConfig) {}
    async load(
        identifier: string,
        requesterId: string,
        signal: AbortSignal
    ): Promise<MusicSearchResult> {
        const url = new URL("/v4/loadtracks", this.config.origin)
        url.searchParams.set("identifier", identifier)
        try {
            const response = await (this.config.fetchImpl ?? fetch)(url, {
                headers: { Authorization: this.config.password },
                redirect: "error",
                signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            })
            if (!response.ok) throw new Error()
            const payload = fluxerRecord(await response.json())
            if (payload.loadType === "empty") return { kind: "empty", tracks: [] }
            if (!["track", "playlist", "search"].includes(String(payload.loadType)))
                throw new Error()
            const rows =
                payload.loadType === "track"
                    ? [payload.data]
                    : payload.loadType === "playlist"
                      ? fluxerRecord(payload.data).tracks
                      : payload.data
            if (!Array.isArray(rows) || rows.length > 10_000) throw new Error()
            const tracks = rows.map((value): MusicTrack => {
                const info = fluxerRecord(fluxerRecord(value).info)
                if (
                    typeof info.identifier !== "string" ||
                    !info.identifier ||
                    typeof info.title !== "string" ||
                    !info.title ||
                    typeof info.author !== "string" ||
                    typeof info.uri !== "string" ||
                    typeof info.sourceName !== "string" ||
                    typeof info.length !== "number" ||
                    !Number.isFinite(info.length) ||
                    info.length < 0 ||
                    typeof info.isStream !== "boolean"
                )
                    throw new Error()
                return {
                    entryId: randomUUID(),
                    source: info.sourceName,
                    sourceId: info.identifier,
                    title: info.title,
                    author: info.author,
                    uri: info.uri,
                    durationMs: info.length,
                    isStream: info.isStream,
                    thumbnailUrl:
                        typeof info.artworkUrl === "string"
                            ? info.artworkUrl
                            : thumbnailUrlFromUri(info.uri),
                    requesterId,
                }
            })
            return { kind: payload.loadType as MusicSearchResult["kind"], tracks }
        } catch {
            signal.throwIfAborted()
            throw new Error("Music metadata search failed")
        }
    }
}
