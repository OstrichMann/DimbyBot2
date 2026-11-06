import type { GuildListItem, GuildListPlayerSummary } from "../types/web.js"
import { isFluxerId } from "./fluxer-user-id.js"

/** Parses a loose player summary from API JSON; rejects invalid status/queueCount. */
export function parseGuildListPlayerSummary(raw: unknown): GuildListPlayerSummary | null {
    if (!raw || typeof raw !== "object") return null
    const p = raw as Record<string, unknown>
    const status = p.status
    if (status !== "playing" && status !== "paused" && status !== "idle") return null
    const queueCount = p.queueCount
    if (typeof queueCount !== "number" || !Number.isFinite(queueCount) || queueCount < 0) {
        return null
    }
    const title =
        typeof p.currentTrackTitle === "string" && p.currentTrackTitle.trim()
            ? p.currentTrackTitle.trim()
            : null
    const author =
        typeof p.currentTrackAuthor === "string" && p.currentTrackAuthor.trim()
            ? p.currentTrackAuthor.trim()
            : null
    const botInVoiceChannel = p.botInVoiceChannel === true || p.botInVoiceChannel === "true"
    const inVoiceWithBot = p.inVoiceWithBot === true || p.inVoiceWithBot === "true"
    return {
        status,
        botInVoiceChannel,
        inVoiceWithBot,
        currentTrackTitle: title,
        currentTrackAuthor: author,
        queueCount: Math.floor(queueCount),
    }
}

/** Accepts loose API data so a single bad row cannot crash the dashboard. */
export function parseSafeGuildListItem(entry: unknown): GuildListItem | null {
    if (!entry || typeof entry !== "object") return null
    const g = entry as Record<string, unknown>
    if (typeof g.name !== "string" || g.name.trim().length === 0) return null
    const name = g.name.trim()
    const idRaw = g.id
    if (typeof idRaw !== "string") return null
    const idStr = isFluxerId(idRaw.trim()) ? idRaw.trim() : null
    if (idStr === null) return null
    const iconRaw = g.iconUrl
    const iconUrl = typeof iconRaw === "string" ? iconRaw.trim() : null
    const mc = g.memberCount
    const memberCount = typeof mc === "number" && Number.isInteger(mc) && mc >= 0 ? mc : null
    const player =
        g.player === null || g.player === undefined ? null : parseGuildListPlayerSummary(g.player)
    return { id: idStr, name, iconUrl, memberCount, player }
}

/** Browser-loaded instance assets allow HTTP(S), without credentials or executable URL schemes. */
export function isValidGuildIconUrl(url: string | null | undefined): url is string {
    if (typeof url !== "string" || !url.trim()) return false
    try {
        const parsed = new URL(url)
        return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password
    } catch {
        return false
    }
}
