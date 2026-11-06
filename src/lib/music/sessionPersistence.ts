import type { MusicService } from "./musicService.js"
import type {
    MusicSnapshot,
    MusicTrack,
    MusicSessionSnapshotV2,
} from "../../shared/music-contract.js"
import { isFluxerId } from "../../shared/fluxer-user-id.js"
import { fluxerRecord } from "../fluxer/entities.js"

export interface StoredMusicSession {
    guildId: string
    voiceChannelId: string
    textChannelId: string | null
    snapshot: unknown
}
export interface MusicSessionStore {
    list(): Promise<StoredMusicSession[]>
    save(row: StoredMusicSession): Promise<void>
    delete(guildId: string): Promise<void>
}
function string(value: unknown, maximum: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maximum
}
function mediaUri(value: string): boolean {
    if (/^spotify:track:[A-Za-z0-9]{22}$/.test(value)) return true
    try {
        const url = new URL(value)
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    } catch {
        return false
    }
}

/** Whitelist track fields at queue/persistence boundaries; SDK data and extra credentials are discarded. */
export function canonicalMusicTrack(value: unknown): MusicTrack | null {
    const raw = fluxerRecord(value)
    if (
        !string(raw.entryId, 128) ||
        !string(raw.source, 64) ||
        !string(raw.sourceId, 2048) ||
        !string(raw.title, 2048) ||
        typeof raw.author !== "string" ||
        raw.author.length > 2048 ||
        !string(raw.uri, 4096) ||
        !mediaUri(raw.uri) ||
        !isFluxerId(raw.requesterId) ||
        typeof raw.durationMs !== "number" ||
        !Number.isFinite(raw.durationMs) ||
        raw.durationMs < 0 ||
        typeof raw.isStream !== "boolean" ||
        (raw.thumbnailUrl !== null &&
            (!string(raw.thumbnailUrl, 4096) || !mediaUri(raw.thumbnailUrl)))
    )
        return null
    return {
        entryId: raw.entryId,
        source: raw.source,
        sourceId: raw.sourceId,
        title: raw.title,
        author: raw.author,
        uri: raw.uri,
        durationMs: raw.durationMs,
        isStream: raw.isStream,
        thumbnailUrl: raw.thumbnailUrl as string | null,
        requesterId: raw.requesterId,
    }
}

/** Invalid/older versions return null and are never implicitly deleted or converted. */
export function parseMusicSessionSnapshot(value: unknown): MusicSessionSnapshotV2 | null {
    const raw = fluxerRecord(value)
    if (
        raw.version !== 2 ||
        typeof raw.volume !== "number" ||
        !Number.isFinite(raw.volume) ||
        raw.volume < 0 ||
        raw.volume > 100 ||
        !["off", "track", "queue"].includes(String(raw.repeatMode)) ||
        typeof raw.paused !== "boolean" ||
        typeof raw.positionMs !== "number" ||
        !Number.isFinite(raw.positionMs) ||
        raw.positionMs < 0 ||
        !Array.isArray(raw.queue) ||
        raw.queue.length > 1000
    )
        return null
    const current = raw.current === null ? null : canonicalMusicTrack(raw.current)
    if (raw.current !== null && !current) return null
    const queue = raw.queue.map(canonicalMusicTrack)
    if (
        queue.some((track) => !track) ||
        queue.length + (current ? 1 : 0) > 1000 ||
        (!current && raw.positionMs !== 0)
    )
        return null
    const ids = [...(current ? [current.entryId] : []), ...queue.map((track) => track!.entryId)]
    if (new Set(ids).size !== ids.length) return null
    return {
        version: 2,
        current,
        queue: queue as MusicTrack[],
        positionMs: raw.positionMs,
        volume: raw.volume,
        repeatMode: raw.repeatMode as MusicSessionSnapshotV2["repeatMode"],
        paused: raw.paused,
    }
}

interface PersistenceDependencies {
    service: MusicService
    store: MusicSessionStore
    canRestore: (row: StoredMusicSession) => Promise<boolean>
    schedule?: (callback: () => void, ms: number) => () => void
    onError?: (error: Error) => void
}

/** Debounced, serialized saves retain the newest snapshot across retries and flush before shutdown. */
export class SessionPersistence {
    private readonly dirty = new Map<string, MusicSnapshot>()
    private readonly known = new Set<string>()
    private readonly schedule: NonNullable<PersistenceDependencies["schedule"]>
    private readonly unsubscribe: () => void
    private cancelDebounce?: () => void
    private cancelCheckpoint?: () => void
    private flushing?: Promise<void>
    private closed = false
    private retry = 0
    constructor(private readonly dependencies: PersistenceDependencies) {
        this.schedule =
            dependencies.schedule ??
            ((callback, ms) => {
                const timer = setTimeout(callback, ms)
                timer.unref()
                return () => clearTimeout(timer)
            })
        this.unsubscribe = dependencies.service.subscribe((snapshot) => this.changed(snapshot))
        this.checkpoint()
    }
    async restore(): Promise<void> {
        for (const row of await this.dependencies.store.list()) {
            const snapshot = parseMusicSessionSnapshot(row.snapshot)
            if (
                !snapshot ||
                !isFluxerId(row.guildId) ||
                !isFluxerId(row.voiceChannelId) ||
                (row.textChannelId !== null && !isFluxerId(row.textChannelId))
            )
                continue
            if (
                this.known.has(row.guildId) ||
                this.dirty.has(row.guildId) ||
                this.dependencies.service.snapshot(row.guildId).revision > 0
            )
                continue
            if (!(await this.dependencies.canRestore(row))) continue
            if (
                this.known.has(row.guildId) ||
                this.dirty.has(row.guildId) ||
                this.dependencies.service.snapshot(row.guildId).revision > 0
            )
                continue
            this.known.add(row.guildId)
            this.dependencies.service.restore({ ...row, snapshot })
        }
    }
    async flush(): Promise<void> {
        this.cancelDebounce?.()
        this.cancelDebounce = undefined
        if (this.flushing) return this.flushing
        const write = async () => {
            while (this.dirty.size) {
                const [guildId, snapshot] = this.dirty.entries().next().value!
                this.dirty.delete(guildId)
                try {
                    if (!snapshot.voiceChannelId) {
                        if (this.known.has(guildId)) {
                            await this.dependencies.store.delete(guildId)
                            this.known.delete(guildId)
                        }
                    } else {
                        const payload: MusicSessionSnapshotV2 = {
                            version: 2,
                            current: snapshot.current,
                            queue: snapshot.queue,
                            positionMs: snapshot.current ? snapshot.positionMs : 0,
                            volume: snapshot.volume,
                            repeatMode: snapshot.repeatMode,
                            paused: snapshot.status === "paused",
                        }
                        await this.dependencies.store.save({
                            guildId,
                            voiceChannelId: snapshot.voiceChannelId,
                            textChannelId: snapshot.textChannelId,
                            snapshot: payload,
                        })
                        this.known.add(guildId)
                    }
                    this.retry = 0
                } catch {
                    if (!this.dirty.has(guildId)) this.dirty.set(guildId, snapshot)
                    throw new Error("Music session persistence failed")
                }
            }
        }
        const task = write()
        this.flushing = task
        try {
            await task
        } finally {
            if (this.flushing === task) this.flushing = undefined
        }
    }
    async shutdown(): Promise<void> {
        this.closed = true
        this.unsubscribe()
        this.cancelDebounce?.()
        this.cancelCheckpoint?.()
        for (const snapshot of this.dependencies.service.allSnapshots())
            this.dirty.set(snapshot.guildId, snapshot)
        await this.flush()
    }
    private changed(snapshot: MusicSnapshot): void {
        if (this.closed) return
        this.dirty.set(snapshot.guildId, snapshot)
        if (!this.cancelDebounce) this.scheduleFlush(500)
    }
    private scheduleFlush(ms: number): void {
        this.cancelDebounce = this.schedule(() => {
            this.cancelDebounce = undefined
            void this.flush().catch(() => {
                this.dependencies.onError?.(new Error("Music session persistence failed"))
                if (!this.closed) this.scheduleFlush(Math.min(30_000, 1000 * 2 ** this.retry++))
            })
        }, ms)
    }
    private checkpoint(): void {
        this.cancelCheckpoint = this.schedule(() => {
            if (this.closed) return
            for (const snapshot of this.dependencies.service.allSnapshots())
                if (snapshot.status === "playing") this.dirty.set(snapshot.guildId, snapshot)
            if (this.dirty.size) {
                this.cancelDebounce?.()
                this.scheduleFlush(0)
            }
            this.checkpoint()
        }, 5000)
    }
}
