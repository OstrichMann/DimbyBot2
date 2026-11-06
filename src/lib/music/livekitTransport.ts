import type { AudioSource, LocalAudioTrack, RoomOptions } from "@livekit/rtc-node"
import type { VoiceGrant } from "../fluxer/voice.js"
import { decodePcm } from "./decoder.js"
import type { PreparedSource } from "./types.js"
import { MusicTransportDisconnectedError } from "./types.js"

export interface AudioSink {
    readonly queuedDuration: number
    capture(frame: Int16Array): Promise<void>
    drain(): Promise<void>
    clear(): void
}
export interface VoiceRoomSession {
    sink: AudioSink
    disconnect(): Promise<void>
    onDisconnect(listener: () => void): () => void
}
interface TransportDependencies {
    openRoom?: (grant: VoiceGrant) => Promise<VoiceRoomSession>
    decode?: typeof decodePcm
}

/** Fluxer passes the grant's string directly to LiveKit's external shared-key provider (PBKDF2). */
export function livekitRoomOptions(grant: VoiceGrant): RoomOptions {
    return {
        autoSubscribe: false,
        dynacast: false,
        ...(grant.e2eeKey
            ? {
                  encryption: {
                      encryptionType: 1,
                      keyProviderOptions: {
                          keyDerivationFunction: 0,
                          ratchetSalt: new TextEncoder().encode("LKFrameEncryptionKey"),
                          keyRingSize: 16,
                          sharedKey: new TextEncoder().encode(grant.e2eeKey),
                          ratchetWindowSize: 0,
                          failureTolerance: -1,
                      },
                  },
              }
            : {}),
    }
}

async function openLivekitRoom(grant: VoiceGrant): Promise<VoiceRoomSession> {
    const {
        Room,
        RoomEvent,
        AudioSource,
        LocalAudioTrack,
        TrackPublishOptions,
        TrackSource,
        AudioFrame,
    } = await import("@livekit/rtc-node")
    const room = new Room()
    let source: AudioSource | undefined, track: LocalAudioTrack | undefined
    let closed = false
    const disconnect = async () => {
        if (closed) return
        closed = true
        try {
            await track?.close(false)
        } finally {
            try {
                await source?.close()
            } finally {
                await room.disconnect()
            }
        }
    }
    try {
        await room.connect(grant.endpoint, grant.token, livekitRoomOptions(grant))
        if (!room.localParticipant) throw new Error()
        source = new AudioSource(48000, 2, 200)
        track = LocalAudioTrack.createAudioTrack("music", source)
        const options = new TrackPublishOptions()
        options.source = TrackSource.SOURCE_MICROPHONE
        await room.localParticipant.publishTrack(track, options)
        const audio = source
        return {
            sink: {
                get queuedDuration() {
                    return audio.queuedDuration
                },
                capture: (frame) =>
                    audio.captureFrame(new AudioFrame(frame, 48000, 2, frame.length / 2)),
                drain: () => audio.waitForPlayout(),
                clear: () => audio.clearQueue(),
            },
            disconnect,
            onDisconnect: (listener) => {
                room.on(RoomEvent.Disconnected, listener)
                return () => {
                    room.off(RoomEvent.Disconnected, listener)
                }
            },
        }
    } catch {
        await disconnect().catch(() => {})
        throw new Error("LiveKit audio connection failed")
    }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener("abort", abort)
            reject(signal.reason)
        }
        signal.addEventListener("abort", abort, { once: true })
        promise.then(
            (value) => {
                signal.removeEventListener("abort", abort)
                resolve(value)
            },
            (error) => {
                signal.removeEventListener("abort", abort)
                reject(error)
            }
        )
    })
}

/** One independently cancellable PCM publisher per guild; SDK queue is capped at 200 ms. */
export class LivekitTransport {
    private readonly dependencies: Required<TransportDependencies>
    private session: VoiceRoomSession | undefined
    private removeDisconnect: (() => void) | undefined
    private connecting: AbortController | undefined
    private controller: AbortController | undefined
    private playing: Promise<void> | undefined
    private capturing: Promise<void> | undefined
    private paused = false
    private wake: (() => void) | undefined
    private volume = 100
    private offset = 0
    private submittedMs = 0
    private connectionLost = false
    constructor(dependencies: TransportDependencies = {}) {
        this.dependencies = { openRoom: openLivekitRoom, decode: decodePcm, ...dependencies }
    }

    async connect(grant: VoiceGrant, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted()
        if (this.session || this.connecting)
            throw new Error("Audio transport is already connected or connecting")
        const controller = new AbortController()
        this.connecting = controller
        const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(15_000)])
        const opening = this.dependencies.openRoom(grant)
        const disposed = new Set<VoiceRoomSession>()
        const dispose = async (session: VoiceRoomSession) => {
            if (!disposed.has(session)) {
                disposed.add(session)
                await session.disconnect()
            }
        }
        void opening
            .then((room) => {
                if (combined.aborted) return dispose(room)
            })
            .catch(() => {})
        try {
            const session = await untilAborted(opening, combined)
            if (combined.aborted) {
                await dispose(session)
                combined.throwIfAborted()
            }
            this.session = session
            this.connectionLost = false
            this.removeDisconnect = session.onDisconnect(() => {
                this.connectionLost = true
                this.controller?.abort(new MusicTransportDisconnectedError())
                this.wake?.()
            })
        } catch {
            combined.throwIfAborted()
            throw new Error("LiveKit audio connection failed")
        } finally {
            if (this.connecting === controller) this.connecting = undefined
        }
    }

    play(source: PreparedSource, offsetMs: number, signal: AbortSignal): Promise<void> {
        if (!this.session || this.connectionLost)
            return source
                .close()
                .catch(() => {})
                .then(() => {
                    throw new MusicTransportDisconnectedError()
                })
        if (this.playing) return Promise.reject(new Error("Audio is already playing"))
        if (!Number.isFinite(offsetMs) || offsetMs < 0 || (offsetMs > 0 && !source.seekable))
            return Promise.reject(new Error("This source cannot seek to that position"))
        const controller = new AbortController()
        this.controller = controller
        this.offset = offsetMs
        this.submittedMs = 0
        const combined = AbortSignal.any([signal, controller.signal])
        const session = this.session
        const run = async () => {
            try {
                combined.throwIfAborted()
                for await (const frame of this.dependencies.decode(
                    source.input,
                    offsetMs,
                    combined
                )) {
                    combined.throwIfAborted()
                    while (this.paused)
                        await untilAborted(
                            new Promise<void>((resolve) => {
                                this.wake = resolve
                            }),
                            combined
                        )
                    combined.throwIfAborted()
                    if (session.sink.queuedDuration >= 180)
                        await untilAborted(session.sink.drain(), combined)
                    const scaled = new Int16Array(frame.length)
                    for (let i = 0; i < frame.length; i++)
                        scaled[i] = Math.max(
                            -32768,
                            Math.min(32767, Math.round((frame[i] * this.volume) / 100))
                        )
                    this.capturing = session.sink.capture(scaled)
                    await untilAborted(this.capturing, combined)
                    this.submittedMs += (frame.length / 2 / 48000) * 1000
                }
                await untilAborted(session.sink.drain(), combined)
            } catch {
                session.sink.clear()
                combined.throwIfAborted()
                throw new Error("Audio playback failed")
            } finally {
                await source.close()
                if (this.controller === controller) {
                    this.controller = undefined
                    this.playing = undefined
                    this.capturing = undefined
                    this.wake = undefined
                }
            }
        }
        const playing = run()
        this.playing = playing
        return playing
    }

    async pause(): Promise<void> {
        this.paused = true
        await this.capturing
        await this.session?.sink.drain()
    }
    async resume(): Promise<void> {
        this.paused = false
        this.wake?.()
        this.wake = undefined
    }
    setVolume(percent: number): void {
        if (!Number.isFinite(percent)) throw new Error("Invalid volume")
        this.volume = Math.max(0, Math.min(100, percent))
    }
    positionMs(): number {
        return Math.floor(
            this.offset + Math.max(0, this.submittedMs - (this.session?.sink.queuedDuration ?? 0))
        )
    }
    async stop(): Promise<void> {
        const capture = this.capturing
        this.controller?.abort()
        this.wake?.()
        this.session?.sink.clear()
        await this.playing?.catch(() => {})
        await capture?.catch(() => {})
        this.session?.sink.clear()
        this.paused = false
        this.offset = 0
        this.submittedMs = 0
    }
    async disconnect(): Promise<void> {
        this.connecting?.abort()
        await this.stop()
        const session = this.session
        this.session = undefined
        this.removeDisconnect?.()
        this.removeDisconnect = undefined
        await session?.disconnect()
    }
}
