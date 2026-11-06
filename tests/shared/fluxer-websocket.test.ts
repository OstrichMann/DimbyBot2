import assert from "node:assert/strict"
import { test } from "node:test"
import { EventEmitter } from "node:events"
import { NativeMusicConnections } from "../../src/shared/websocket/NativeMusicConnections.js"
import { musicServiceHarness, settleMusic } from "../test-support/musicServiceFakes.js"
import { MusicAccessError } from "../../src/lib/fluxer/access.js"
import type { AuthenticatedActor } from "../../src/shared/fluxer-session.js"
class Socket extends EventEmitter {
    readyState = 1
    sent: any[] = []
    send(text: string) {
        this.sent.push(JSON.parse(text))
    }
    close() {
        this.readyState = 3
        this.emit("close")
    }
}
const actor = (id: string): AuthenticatedActor => ({
    userId: id,
    authUserId: `uuid-${id}`,
    sessionId: `session-${id}`,
    expiresAt: Date.now() + 60000,
})
test("live subscriptions check session and access, compose each viewer, and revoke on invalidation", async () => {
    let deny = false,
        expired = false
    const h = musicServiceHarness(),
        a = new Socket(),
        b = new Socket()
    const manager = new NativeMusicConnections({
        music: h.service,
        authenticate: async (headers) => {
            if (expired) throw new Error("session revoked")
            return actor(headers.get("x-test-id")!)
        },
        authorize: async (who) => {
            if (deny) throw new MusicAccessError(403, "Denied")
            return { inVoiceWithBot: who.userId === "9", canQueueTracks: who.userId === "9" }
        },
        schedule: (fn) => {
            queueMicrotask(fn)
            return () => {}
        },
    })
    await manager.add(a, new Headers({ "x-test-id": "9" }))
    await manager.add(b, new Headers({ "x-test-id": "8" }))
    a.emit("message", JSON.stringify({ type: "subscribe", guildId: "1" }))
    b.emit("message", JSON.stringify({ type: "subscribe", guildId: "1" }))
    await settleMusic()
    assert.equal(a.sent.find((frame) => frame.type === "queueUpdate").state.canQueueTracks, true)
    assert.equal(b.sent.find((frame) => frame.type === "queueUpdate").state.canQueueTracks, false)
    deny = true
    manager.invalidate("1")
    await settleMusic()
    assert.ok(a.sent.some((frame) => frame.type === "unsubscribed"))
    assert.ok(b.sent.some((frame) => frame.type === "unsubscribed"))
    deny = false
    expired = true
    a.emit("message", JSON.stringify({ type: "subscribe", guildId: "1" }))
    await settleMusic()
    assert.equal(a.readyState, 3)
    const unauthenticated = new Socket()
    await manager.add(unauthenticated, new Headers())
    assert.equal(unauthenticated.readyState, 3)
    manager.stop()
})
test("subscribe races cannot resurrect an unsubscribed guild and malformed frames fail safely", async () => {
    const h = musicServiceHarness(),
        socket = new Socket()
    let release: () => void
    const waiting = new Promise<void>((resolve) => {
        release = resolve
    })
    const manager = new NativeMusicConnections({
        music: h.service,
        authenticate: async () => actor("9"),
        authorize: async () => {
            await waiting
            return { inVoiceWithBot: true, canQueueTracks: true }
        },
    })
    await manager.add(socket, new Headers())
    socket.emit("message", '{"type":"subscribe","guildId":"1"}')
    socket.emit("message", '{"type":"unsubscribe","guildId":"1"}')
    release!()
    await settleMusic()
    assert.equal(
        socket.sent.some((frame) => frame.type === "subscribed"),
        false
    )
    socket.emit("message", "bad-json")
    await settleMusic()
    assert.equal(socket.sent.at(-1).code, "INVALID_MESSAGE")
    socket.emit("message", '{"type":"ping"}')
    await settleMusic()
    assert.equal(socket.sent.at(-1).type, "pong")
    manager.stop()
})

test("slow WebSocket viewers are closed before outbound updates can buffer without limit", async () => {
    const h = musicServiceHarness()
    const socket = Object.assign(new Socket(), { bufferedAmount: 2 * 1024 * 1024 })
    const manager = new NativeMusicConnections({
        music: h.service,
        authenticate: async () => actor("9"),
        authorize: async () => ({ inVoiceWithBot: true, canQueueTracks: true }),
    })
    await manager.add(socket, new Headers())
    socket.emit("message", '{"type":"ping"}')
    await settleMusic()
    assert.equal(socket.readyState, 3)
    assert.equal(socket.sent.length, 0)
    manager.stop()
})

test("transient authority failure withholds updates but keeps a subscription for recovery", async () => {
    const h = musicServiceHarness(),
        socket = new Socket()
    let unavailable = false
    const scheduled: (() => void)[] = []
    const manager = new NativeMusicConnections({
        music: h.service,
        authenticate: async () => actor("9"),
        authorize: async () => {
            if (unavailable) throw new MusicAccessError(503, "Guild changed")
            return { inVoiceWithBot: false, canQueueTracks: true }
        },
        schedule: (fn) => {
            scheduled.push(fn)
            return () => {}
        },
    })
    await manager.add(socket, new Headers())
    socket.emit("message", '{"type":"subscribe","guildId":"1"}')
    await settleMusic()
    const before = socket.sent.filter((frame) => frame.type === "queueUpdate").length
    unavailable = true
    manager.invalidate("1")
    scheduled.shift()!()
    await settleMusic()
    assert.equal(socket.sent.filter((frame) => frame.type === "queueUpdate").length, before)
    assert.equal(
        socket.sent.some((frame) => frame.type === "unsubscribed"),
        false
    )
    unavailable = false
    manager.invalidate("1")
    scheduled.shift()!()
    await settleMusic()
    assert.equal(socket.sent.filter((frame) => frame.type === "queueUpdate").length, before + 1)
    manager.stop()
})

test("open subscriptions are not reauthorized on a timer", async () => {
    const delays: number[] = []
    const original = globalThis.setInterval
    globalThis.setInterval = ((handler: () => void, timeout?: number) => {
        delays.push(Number(timeout))
        return original(handler, timeout)
    }) as typeof setInterval
    const h = musicServiceHarness(),
        socket = new Socket()
    let calls = 0
    let manager: NativeMusicConnections | undefined
    try {
        manager = new NativeMusicConnections({
            music: h.service,
            authenticate: async () => actor("9"),
            authorize: async () => {
                calls++
                return { inVoiceWithBot: false, canQueueTracks: true }
            },
        })
        await manager.add(socket, new Headers())
        socket.emit("message", JSON.stringify({ type: "subscribe", guildId: "1" }))
        await settleMusic()
        assert.equal(calls, 1)
        assert.equal(delays.includes(15000), false)
    } finally {
        manager?.stop()
        globalThis.setInterval = original
    }
})
