/** Pure companion wire-format helpers, independent of any player SDK. */
const PREFERRED_AUDIO_ITAGS = [251, 140] as const
const YOUTUBE_VIDEO_ID_RE = /^[\w-]{11}$/

type FormatLike = {
    itag?: number
    mimeType?: string
    mime_type?: string
}

type PlayerJsonLike = {
    playabilityStatus?: { status?: string; reason?: string }
    playability_status?: { status?: string; reason?: string }
    streamingData?: { formats?: FormatLike[]; adaptiveFormats?: FormatLike[] }
    streaming_data?: { formats?: FormatLike[]; adaptive_formats?: FormatLike[] }
    videoDetails?: { lengthSeconds?: string | number }
    video_details?: { length_seconds?: string | number }
}

export function youtubeVideoIdFromUri(uri: string): string | null {
    if (!uri) return null
    try {
        const url = new URL(uri)
        const host = url.hostname.replace(/^www\./, "")
        if (host === "youtu.be") {
            const id = url.pathname.split("/").filter(Boolean)[0]
            return id && YOUTUBE_VIDEO_ID_RE.test(id) ? id : null
        }
        if (host === "youtube.com" || host === "music.youtube.com" || host === "m.youtube.com") {
            const v = url.searchParams.get("v")
            if (v && YOUTUBE_VIDEO_ID_RE.test(v)) return v
            const parts = url.pathname.split("/").filter(Boolean)
            if (
                (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live") &&
                parts[1]
            ) {
                return YOUTUBE_VIDEO_ID_RE.test(parts[1]) ? parts[1] : null
            }
        }
    } catch {
        return null
    }
    return null
}

export function collectPlayerFormats(playerJson: PlayerJsonLike): FormatLike[] {
    const camel = playerJson.streamingData
    const snake = playerJson.streaming_data
    const formats = [
        ...(camel?.formats ?? []),
        ...(camel?.adaptiveFormats ?? []),
        ...(snake?.formats ?? []),
        ...(snake?.adaptive_formats ?? []),
    ]
    return formats
}

/** Prefers itag 251 (Opus) then 140 (AAC); otherwise the first audio mimeType. */
export function pickPreferredAudioItag(formats: FormatLike[]): number | null {
    const itags = new Set(
        formats.map((f) => f.itag).filter((n): n is number => typeof n === "number")
    )
    for (const preferred of PREFERRED_AUDIO_ITAGS) {
        if (itags.has(preferred)) return preferred
    }
    const audio = formats.find((f) => {
        const mime = f.mimeType ?? f.mime_type ?? ""
        return mime.startsWith("audio/")
    })
    return typeof audio?.itag === "number" ? audio.itag : null
}

export function companionLatestVersionPath(videoId: string, itag: number): string {
    return `/companion/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(String(itag))}&local=true`
}

export function ensureCompanionOriginStreamUrl(streamUrl: string, companionOrigin: string): string {
    const origin = companionOrigin.replace(/\/+$/, "")
    const companion = new URL(origin)
    let parsed: URL
    try {
        parsed = new URL(streamUrl, `${origin}/`)
    } catch {
        throw new Error("invidious-companion returned an invalid stream URL.")
    }
    if (parsed.host === companion.host) return parsed.toString()
    if (parsed.hostname.endsWith(".googlevideo.com")) {
        const proxy = new URL("/companion/videoplayback", `${origin}/`)
        proxy.search = parsed.search
        proxy.searchParams.set("host", parsed.hostname)
        return proxy.toString()
    }
    throw new Error(`Refusing to play non-companion HTTP URL (host ${parsed.host}).`)
}

/** Companion player JSON video length in ms, or null when missing/invalid. */
export function companionLengthMsFromPlayerJson(playerJson: {
    videoDetails?: { lengthSeconds?: string | number }
    video_details?: { length_seconds?: string | number }
}): number | null {
    const raw = playerJson.videoDetails?.lengthSeconds ?? playerJson.video_details?.length_seconds
    const seconds = typeof raw === "string" ? Number(raw) : raw
    if (!Number.isFinite(seconds) || seconds <= 0) return null
    return Math.floor(seconds * 1000)
}
