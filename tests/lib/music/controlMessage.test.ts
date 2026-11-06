import assert from "node:assert/strict"
import { test } from "node:test"
import { ControlMessage } from "../../../src/lib/music/controlMessage.js"
import { FluxerRestError } from "../../../src/lib/fluxer/rest.js"
import { musicServiceHarness, settleMusic } from "../../test-support/musicServiceFakes.js"
import type { MusicSnapshot } from "../../../src/shared/music-contract.js"

test("now-playing updates coalesce and edit retained IDs; a missing message is recreated once", async () => {
    let listener: (state: MusicSnapshot) => void,
        callback: () => void,
        missing = false,
        messageId: string | null = null
    const writes: { method: string; path: string; body: any }[] = []
    const poster = new ControlMessage({
        music: {
            subscribe: (fn) => {
                listener = fn
                return () => {
                    listener = () => {}
                }
            },
        },
        settings: () => ({ channelId: "4", messageId }),
        saveMessageId: async (_guild, _channel, id) => {
            messageId = id
        },
        schedule: (fn) => {
            callback = fn
            return () => {
                callback = () => {}
            }
        },
        rest: {
            request: async (method, path, options) => {
                writes.push({ method, path, body: options?.body })
                if (missing && method === "PATCH") {
                    missing = false
                    throw new FluxerRestError(404)
                }
                return { id: "5" } as any
            },
        },
    })
    const state = musicServiceHarness().service.snapshot("1")
    listener!(state)
    listener!({ ...state, volume: 42 })
    callback!()
    await settleMusic()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, "POST")
    assert.equal(messageId, "5")
    assert.deepEqual(writes[0].body.allowed_mentions, { parse: [] })
    listener!({ ...state, volume: 44 })
    callback!()
    await settleMusic()
    assert.equal(writes[1].method, "PATCH")
    missing = true
    listener!({ ...state, volume: 45 })
    callback!()
    await settleMusic()
    assert.deepEqual(
        writes.slice(2).map((write) => write.method),
        ["PATCH", "POST"]
    )
    poster.stop()
    listener!(state)
    callback!()
    await settleMusic()
    assert.equal(writes.length, 4)
})

test("failed ID persistence retains local ID and ambiguous writes are not retried", async () => {
    let listener: (state: MusicSnapshot) => void,
        callback: () => void,
        ambiguous = false
    const methods: string[] = []
    const poster = new ControlMessage({
        music: {
            subscribe: (fn) => {
                listener = fn
                return () => {}
            },
        },
        settings: () => ({ channelId: "4", messageId: null }),
        saveMessageId: async () => {
            throw new Error("database secret")
        },
        schedule: (fn) => {
            callback = fn
            return () => {}
        },
        rest: {
            request: async (method) => {
                methods.push(method)
                if (ambiguous) throw new Error("network secret")
                return { id: "5" } as any
            },
        },
    })
    const state = musicServiceHarness().service.snapshot("1")
    listener!(state)
    callback!()
    await settleMusic()
    listener!(state)
    callback!()
    await settleMusic()
    assert.deepEqual(methods, ["POST", "PATCH"])
    ambiguous = true
    listener!(state)
    callback!()
    await settleMusic()
    assert.deepEqual(methods, ["POST", "PATCH", "PATCH"])
    poster.stop()
})
