import type { MusicTransport, PreparedSource } from "../../src/lib/music/types.js"
import type { MusicTrack } from "../../src/shared/music-contract.js"
import { MusicService } from "../../src/lib/music/musicService.js"
import { MusicAccessError } from "../../src/lib/fluxer/access.js"
import { FluxerClock, flushFluxer } from "./fluxerFakes.js"

export function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}
export function musicTrack(title: string): MusicTrack {
    return {
        entryId: `entry-${title}`,
        title,
        author: "Artist",
        source: "youtube",
        sourceId: "dQw4w9WgXcQ",
        uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        durationMs: 100000,
        isStream: false,
        thumbnailUrl: null,
        requesterId: "9",
    }
}
export class FakeMusicTransport implements MusicTransport {
    connected = false
    paused = false
    volume = 100
    position = 0
    plays: ReturnType<typeof deferred<void>>[] = []
    private active?: Promise<void>
    connectGate?: ReturnType<typeof deferred<void>>
    pauseGate?: ReturnType<typeof deferred<void>>
    async connect(_grant: unknown, signal: AbortSignal) {
        signal.throwIfAborted()
        if (this.connectGate) await this.connectGate.promise
        signal.throwIfAborted()
        this.connected = true
    }
    play(source: PreparedSource, offset: number, signal: AbortSignal) {
        const work = deferred<void>()
        this.plays.push(work)
        this.position = offset
        const abort = () => work.reject(new DOMException("aborted", "AbortError"))
        signal.addEventListener("abort", abort, { once: true })
        this.active = work.promise.finally(async () => {
            signal.removeEventListener("abort", abort)
            await source.close()
        })
        return this.active
    }
    async pause() {
        this.paused = true
        if (this.pauseGate) await this.pauseGate.promise
    }
    async resume() {
        this.paused = false
    }
    setVolume(value: number) {
        this.volume = value
    }
    positionMs() {
        return this.position
    }
    async stop() {
        this.plays.at(-1)?.reject(new DOMException("aborted", "AbortError"))
        await this.active?.catch(() => {})
        this.position = 0
        this.paused = false
    }
    async disconnect() {
        await this.stop()
        this.connected = false
    }
    finish(index = this.plays.length - 1) {
        this.plays[index]?.resolve()
    }
}

export function musicServiceHarness() {
    const clock = new FluxerClock(),
        transports = new Map<string, FakeMusicTransport>(),
        voice = new Map<string, string>()
    let denied = false,
        botDenied = false,
        leaveFailed = false,
        listeners = true,
        prepares = 0,
        closes = 0
    let connectGate: ReturnType<typeof deferred<void>> | undefined
    let prepareGate: ReturnType<typeof deferred<void>> | undefined
    const loads = new Map<
        string,
        ReturnType<typeof deferred<{ kind: "search"; tracks: MusicTrack[] }>>
    >()
    const service = new MusicService({
        access: {
            authorizeMusic: async (actor, _action, channelId) => {
                if (denied) throw new MusicAccessError(403, "denied")
                return { ...actor, voiceChannelId: channelId ?? voice.get(actor.guildId) ?? "2" }
            },
        },
        resolver: {
            load: async (query) =>
                loads.get(query)?.promise ?? { kind: "search", tracks: [musicTrack(query)] },
            prepare: async (track, signal) => {
                signal.throwIfAborted()
                if (prepareGate) await prepareGate.promise
                signal.throwIfAborted()
                prepares++
                return {
                    input: (async function* () {})(),
                    durationMs: track.durationMs + 1000,
                    playbackUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                    seekable: !track.isStream,
                    close: async () => {
                        closes++
                    },
                }
            },
        },
        voice: {
            join: async (guildId, channelId, signal) => {
                signal.throwIfAborted()
                voice.set(guildId, channelId)
                return { endpoint: "wss://voice.example", token: "test", connectionId: guildId }
            },
            leave: async (id) => {
                voice.delete(id)
                if (leaveFailed) throw new Error("Gateway unavailable")
            },
            channelId: (id) => voice.get(id) ?? null,
        },
        transportFactory: (id) => {
            const transport = new FakeMusicTransport()
            transport.connectGate = connectGate
            transports.set(id, transport)
            return transport
        },
        verifyBotAccess: async () => {
            if (botDenied) throw new Error("permission denied")
        },
        hasListeners: () => listeners,
        schedule: clock.schedule,
        random: () => 0,
    })
    return {
        service,
        clock,
        transports,
        voice,
        loads,
        setPrepareGate: (gate?: ReturnType<typeof deferred<void>>) => {
            prepareGate = gate
        },
        setConnectGate: (gate?: ReturnType<typeof deferred<void>>) => {
            connectGate = gate
        },
        deny: (value = true) => {
            denied = value
        },
        failLeave: () => {
            leaveFailed = true
        },
        denyBot: () => {
            botDenied = true
        },
        listeners: (value: boolean) => {
            listeners = value
        },
        prepares: () => prepares,
        closes: () => closes,
    }
}
export const musicActor = { guildId: "1", userId: "9", textChannelId: "3" }
export async function settleMusic() {
    for (let i = 0; i < 5; i++) await flushFluxer()
}
