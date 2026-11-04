import {
    collectPlayerFormats,
    pickPreferredAudioItag,
    companionLatestVersionPath,
    companionLengthMsFromPlayerJson,
    ensureCompanionOriginStreamUrl,
} from "./companionProtocol.js"
import { fluxerRecord } from "../fluxer/entities.js"
import type { PreparedSource } from "./types.js"

interface CompanionConfig {
    origin: string
    secret: string
    fetchImpl?: typeof fetch
}

/** Resolves YouTube into companion-owned byte streams without giving its credential to redirects. */
export class CompanionSource {
    constructor(private readonly config: CompanionConfig) {}
    async prepare(videoId: string, signal: AbortSignal): Promise<PreparedSource> {
        if (!/^[\w-]{11}$/.test(videoId)) throw new Error("Invalid YouTube video ID")
        const lifetime = new AbortController()
        const combined = AbortSignal.any([signal, lifetime.signal])
        const origin = new URL(this.config.origin).origin
        const fetchHeaders = async (
            url: string,
            method = "GET",
            body?: string
        ): Promise<Response> => {
            const target = new URL(url, origin)
            if (target.origin !== origin || target.username || target.password)
                throw new Error("Companion redirected outside its configured origin")
            const timeout = new AbortController(),
                timer = setTimeout(() => timeout.abort(), 10_000)
            try {
                return await (this.config.fetchImpl ?? fetch)(target, {
                    method,
                    redirect: "manual",
                    signal: AbortSignal.any([combined, timeout.signal]),
                    headers: {
                        Authorization: `Bearer ${this.config.secret}`,
                        ...(body ? { "Content-Type": "application/json" } : {}),
                    },
                    body,
                })
            } finally {
                clearTimeout(timer)
            }
        }
        try {
            const player = await fetchHeaders(
                "/companion/youtubei/v1/player",
                "POST",
                JSON.stringify({ videoId })
            )
            if (!player.ok) throw new Error()
            const data = fluxerRecord(await player.json())
            const status = fluxerRecord(data.playabilityStatus ?? data.playability_status).status
            if (status && status !== "OK") throw new Error()
            const itag = pickPreferredAudioItag(collectPlayerFormats(data))
            if (itag === null) throw new Error()
            let url = new URL(companionLatestVersionPath(videoId, itag), origin).href
            for (let hop = 0; hop <= 5; hop++) {
                const response = await fetchHeaders(url)
                if ([301, 302, 303, 307, 308].includes(response.status)) {
                    const location = response.headers.get("location")
                    await response.body?.cancel()
                    if (!location || hop === 5) throw new Error()
                    url = ensureCompanionOriginStreamUrl(new URL(location, url).href, origin)
                    continue
                }
                if (!response.ok || !response.body) throw new Error()
                const body = response.body
                const durationMs = companionLengthMsFromPlayerJson(data)
                return {
                    input: body,
                    durationMs,
                    playbackUrl: `https://www.youtube.com/watch?v=${videoId}`,
                    seekable: durationMs !== null,
                    close: async () => {
                        lifetime.abort()
                        await body.cancel().catch(() => {})
                    },
                }
            }
            throw new Error()
        } catch {
            lifetime.abort()
            signal.throwIfAborted()
            throw new Error("YouTube companion source unavailable")
        }
    }
}
