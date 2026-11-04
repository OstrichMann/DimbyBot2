import assert from "node:assert/strict"
import { test } from "node:test"
import {
    LivekitTransport,
    livekitRoomOptions,
    type VoiceRoomSession,
} from "../../../src/lib/music/livekitTransport.js"
import { preparedFixture } from "../../test-support/musicFakes.js"
import { flushFluxer } from "../../test-support/fluxerFakes.js"

const grant = { endpoint: "wss://voice.example", token: "secret", connectionId: "conn" }
function harness(
    decode = async function* () {
        for (let i = 0; i < 25; i++) yield new Int16Array(1920).fill(10000)
    }
) {
    const frames: Int16Array[] = []
    let queued = 0,
        maximum = 0,
        closed = 0,
        sourceClosed = 0
    let onCapture = async () => {}
    const sink = {
        get queuedDuration() {
            return queued
        },
        capture: async (frame: Int16Array) => {
            frames.push(frame)
            queued += 20
            maximum = Math.max(maximum, queued)
            await onCapture()
        },
        drain: async () => {
            queued = 0
        },
        clear: () => {
            queued = 0
        },
        close: async () => {},
    }
    const transport = new LivekitTransport({
        decode,
        openRoom: async () => ({
            sink,
            disconnect: async () => {
                closed++
            },
            onDisconnect: () => () => {},
        }),
    })
    const source = {
        ...preparedFixture(),
        close: async () => {
            sourceClosed++
        },
    }
    return {
        transport,
        source,
        frames,
        maximum: () => maximum,
        closed: () => closed,
        sourceClosed: () => sourceClosed,
        setCapture: (callback: () => Promise<void>) => {
            onCapture = callback
        },
    }
}

test("publishes with bounded buffering, gain and one natural completion", async () => {
    const h = harness()
    await h.transport.connect(grant, new AbortController().signal)
    h.transport.setVolume(50)
    await h.transport.play(h.source, 0, new AbortController().signal)
    assert.equal(h.frames.length, 25)
    assert.equal(h.frames[0][0], 5000)
    assert.ok(h.maximum() <= 200)
    assert.equal(h.transport.positionMs(), 500)
    assert.equal(h.sourceClosed(), 1)
    await h.transport.disconnect()
    await h.transport.disconnect()
    assert.equal(h.closed(), 1)
})

test("pause drains buffered frames and freezes the position until resume", async () => {
    const h = harness()
    let release!: () => void
    h.setCapture(async () => {
        await new Promise<void>((resolve) => {
            release = resolve
        })
    })
    await h.transport.connect(grant, new AbortController().signal)
    const playing = h.transport.play(h.source, 0, new AbortController().signal)
    await flushFluxer()
    const paused = h.transport.pause()
    release()
    await paused
    const position = h.transport.positionMs(),
        count = h.frames.length
    await flushFluxer()
    assert.equal(h.transport.positionMs(), position)
    assert.equal(h.frames.length, count)
    h.setCapture(async () => {})
    await h.transport.resume()
    await playing
    assert.equal(h.frames.length, 25)
    await h.transport.disconnect()
})

test("stop cancels a paused play and closes its source once", async () => {
    const h = harness()
    await h.transport.connect(grant, new AbortController().signal)
    await h.transport.pause()
    const playing = h.transport.play(h.source, 0, new AbortController().signal)
    const rejected = assert.rejects(playing, { name: "AbortError" })
    await flushFluxer()
    await h.transport.stop()
    await rejected
    assert.equal(h.sourceClosed(), 1)
    await h.transport.disconnect()
})

test("stop waits for an in-flight audio submission before allowing a successor play", async () => {
    const h = harness()
    let release!: () => void,
        stopped = false
    h.setCapture(
        () =>
            new Promise<void>((resolve) => {
                release = resolve
            })
    )
    await h.transport.connect(grant, new AbortController().signal)
    const playing = h.transport.play(h.source, 0, new AbortController().signal)
    const rejected = assert.rejects(playing, { name: "AbortError" })
    await flushFluxer()
    const stopping = h.transport.stop().then(() => {
        stopped = true
    })
    await flushFluxer()
    assert.equal(stopped, false)
    release()
    await stopping
    await rejected
    assert.equal(h.transport.positionMs(), 0)
    await h.transport.disconnect()
})

test("transport decode failures close the input and return a sanitized playback error", async () => {
    const h = harness(async function* () {
        throw new Error("secret input URL")
    })
    await h.transport.connect(grant, new AbortController().signal)
    await assert.rejects(
        h.transport.play(h.source, 0, new AbortController().signal),
        (error: Error) => error.message === "Audio playback failed"
    )
    assert.equal(h.sourceClosed(), 1)
    await h.transport.disconnect()
})

test("non-seekable sources reject seek and volume inputs are finite and bounded", async () => {
    const h = harness()
    await h.transport.connect(grant, new AbortController().signal)
    h.source.seekable = false
    await assert.rejects(h.transport.play(h.source, 100, new AbortController().signal), /seek/i)
    for (const volume of [NaN, Infinity]) assert.throws(() => h.transport.setVolume(volume))
    h.transport.setVolume(200)
    await h.transport.play(h.source, 0, new AbortController().signal)
    assert.equal(h.frames[0][0], 10000)
    await h.transport.disconnect()
})

test("encrypted grants use UTF-8 shared-key PBKDF2 parameters compatible with Fluxer's client", () => {
    const options = livekitRoomOptions({ ...grant, e2eeKey: "a room password" })
    assert.deepEqual(
        [...options.encryption!.keyProviderOptions.sharedKey!],
        [...new TextEncoder().encode("a room password")]
    )
    assert.equal(options.encryption!.keyProviderOptions.keyDerivationFunction, 0)
    assert.equal(options.encryption!.keyProviderOptions.ratchetWindowSize, 0)
    assert.equal(livekitRoomOptions(grant).encryption, undefined)
})

test("canceled connect closes a late room instead of leaving a live audio session", async () => {
    let resolve!: (session: VoiceRoomSession) => void,
        closed = 0
    const h = harness()
    const transport = new LivekitTransport({
        openRoom: async () =>
            new Promise((r) => {
                resolve = r
            }),
        decode: async function* () {},
    })
    const controller = new AbortController(),
        connecting = transport.connect(grant, controller.signal)
    controller.abort()
    const rejected = assert.rejects(connecting, { name: "AbortError" })
    resolve({
        sink: {
            queuedDuration: 0,
            capture: async () => {},
            drain: async () => {},
            clear: () => {},
        },
        disconnect: async () => {
            closed++
        },
        onDisconnect: () => () => {},
    })
    await rejected
    await flushFluxer()
    assert.equal(closed, 1)
    await transport.disconnect()
    await h.transport.disconnect()
})

test("room loss during source preparation rejects the next play as a transport failure and closes its source", async () => {
    const { MusicTransportDisconnectedError } = await import("../../../src/lib/music/types.js")
    let lost: () => void,
        closed = 0
    const transport = new LivekitTransport({
        openRoom: async () => ({
            sink: {
                queuedDuration: 0,
                capture: async () => {},
                drain: async () => {},
                clear: () => {},
            },
            disconnect: async () => {},
            onDisconnect: (listener) => {
                lost = listener
                return () => {}
            },
        }),
        decode: async function* () {
            yield new Int16Array(1920)
        },
    })
    await transport.connect(grant, new AbortController().signal)
    lost!()
    await assert.rejects(
        transport.play(
            {
                ...preparedFixture(),
                close: async () => {
                    closed++
                },
            },
            0,
            new AbortController().signal
        ),
        MusicTransportDisconnectedError
    )
    assert.equal(closed, 1)
    await transport.disconnect()
})
