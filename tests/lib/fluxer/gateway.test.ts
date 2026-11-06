import assert from "node:assert/strict"
import { test } from "node:test"
import { FluxerGateway } from "../../../src/lib/fluxer/gateway.js"
import { FakeFluxerSocket, FluxerClock, flushFluxer } from "../../test-support/fluxerFakes.js"

function harness(onDispatch = async (_event: unknown) => {}) {
    const clock = new FluxerClock()
    const sockets: FakeFluxerSocket[] = []
    const errors: Error[] = []
    let url = ""
    const gateway = new FluxerGateway("wss://gateway.example/?keep=1", "secret", {
        socketFactory: (input) => {
            url = input
            const socket = new FakeFluxerSocket()
            sockets.push(socket)
            return socket
        },
        schedule: clock.schedule,
        now: () => clock.now,
        random: () => 0,
        onDispatch,
        onError: (error) => errors.push(error),
    })
    return { gateway, clock, sockets, errors, url: () => url }
}

async function ready(h: ReturnType<typeof harness>) {
    const started = h.gateway.start()
    h.sockets[0].packet({ op: 10, d: { heartbeat_interval: 1000 } })
    h.sockets[0].packet({
        op: 0,
        s: 1,
        t: "READY",
        d: { session_id: "session", user: { id: "9" } },
    })
    await started
    return h.sockets[0]
}

test("identifies after Hello and resumes the accepted sequence after heartbeat timeout", async () => {
    const h = harness()
    const socket = await ready(h)
    assert.equal(new URL(h.url()).searchParams.get("v"), "1")
    assert.equal(new URL(h.url()).searchParams.get("keep"), "1")
    assert.equal(socket.sent[0].op, 2)
    socket.packet({ op: 0, s: 2, t: "GUILD_CREATE", d: { id: "1" } })
    await flushFluxer()
    await h.clock.advance(1000)
    assert.deepEqual(socket.sent.at(-1), { op: 1, d: 2 })
    await h.clock.advance(2000)
    assert.equal(h.sockets.length, 2)
    h.sockets[1].packet({ op: 10, d: { heartbeat_interval: 1000 } })
    assert.deepEqual(h.sockets[1].sent[0], {
        op: 6,
        d: { token: "secret", session_id: "session", seq: 2 },
    })
    await h.gateway.stop()
    assert.equal(h.clock.pending, 0)
})

test("acknowledges only accepted dispatches and deduplicates replayed messages", async () => {
    const seen: unknown[] = []
    let accept!: () => void
    const h = harness(async (event: { t?: string }) => {
        if (event.t !== "MESSAGE_CREATE") return
        seen.push(event)
        await new Promise<void>((resolve) => {
            accept = resolve
        })
    })
    const socket = await ready(h)
    socket.packet({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "44" } })
    await flushFluxer()
    socket.packet({ op: 1 })
    assert.deepEqual(socket.sent.at(-1), { op: 1, d: 1 })
    accept()
    await flushFluxer()
    socket.packet({ op: 0, s: 3, t: "MESSAGE_CREATE", d: { id: "44" } })
    await flushFluxer()
    assert.equal(seen.length, 1)
    socket.packet({ op: 1 })
    assert.deepEqual(socket.sent.at(-1), { op: 1, d: 3 })
    await h.gateway.stop()
})

test("invalid session identifies afresh while fatal auth failure rejects startup", async () => {
    const h = harness()
    const socket = await ready(h)
    socket.packet({ op: 9, d: false })
    await h.clock.advance(1000)
    const next = h.sockets[1]
    next.packet({ op: 10, d: { heartbeat_interval: 1000 } })
    assert.equal(next.sent[0].op, 2)
    await h.gateway.stop()
    const fatal = harness()
    const started = fatal.gateway.start()
    fatal.sockets[0].close(4004)
    await assert.rejects(started, /authentication/i)
    await fatal.clock.advance(60_000)
    assert.equal(fatal.sockets.length, 1)
    assert.equal(fatal.clock.pending, 0)
})

test("malformed packets reconnect without reflecting payloads and stopped sockets cannot dispatch", async () => {
    const seen: unknown[] = []
    const h = harness(async (event) => {
        seen.push(event)
    })
    const socket = await ready(h)
    socket.emit("message", Buffer.from("secret not JSON"))
    assert.equal(h.errors[0].message.includes("secret"), false)
    await h.gateway.stop()
    socket.packet({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "44" } })
    await flushFluxer()
    assert.equal(seen.length, 1)
    assert.throws(() => h.gateway.send(4, {}), /ready/i)
})

test("heartbeat acknowledgments keep the connection alive and dispatch failures are reported safely", async () => {
    const h = harness(async (event: { t?: string }) => {
        if (event.t === "MESSAGE_CREATE") throw new Error("secret upstream error")
    })
    const socket = await ready(h)
    for (let i = 0; i < 4; i++) {
        await h.clock.advance(1000)
        socket.packet({ op: 11 })
    }
    assert.equal(h.sockets.length, 1)
    socket.packet({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "44" } })
    await flushFluxer()
    assert.equal(h.errors[0].message.includes("secret"), false)
    await h.gateway.stop()
})

test("dispatches replayed events before RESUMED and keeps their accepted sequence", async () => {
    const seen: string[] = []
    const h = harness(async (event: { t?: string }) => {
        seen.push(event.t ?? "")
    })
    const socket = await ready(h)
    socket.close(1006)
    await h.clock.advance(1000)
    const next = h.sockets[1]
    next.packet({ op: 10, d: { heartbeat_interval: 1000 } })
    next.packet({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "77" } })
    next.packet({ op: 0, s: 2, t: "RESUMED", d: {} })
    await flushFluxer()
    assert.deepEqual(seen, ["READY", "MESSAGE_CREATE", "RESUMED"])
    assert.equal(h.gateway.ready, true)
    next.packet({ op: 1 })
    assert.deepEqual(next.sent.at(-1), { op: 1, d: 2 })
    await h.gateway.stop()
})

test("rejected command acceptance preserves resume sequence and permits replay instead of deduplicating a lost command", async () => {
    let attempts = 0
    const h = harness(async (event: { t?: string }) => {
        if (event.t === "MESSAGE_CREATE" && ++attempts === 1) throw new Error("queue full")
    })
    const first = await ready(h)
    first.packet({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "88" } })
    await flushFluxer()
    await h.clock.advance(1000)
    const next = h.sockets[1]
    assert.ok(next, "unaccepted dispatch reconnects for replay")
    next.packet({ op: 10, d: { heartbeat_interval: 1000 } })
    assert.equal((next.sent[0].d as { seq: number }).seq, 1)
    next.packet({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "88" } })
    next.packet({ op: 0, s: 3, t: "RESUMED", d: {} })
    await flushFluxer()
    assert.equal(attempts, 2)
    await h.gateway.stop()
})

test("a heartbeat due while the socket is closing reconnects instead of throwing from the timer", async () => {
    const h = harness()
    const socket = await ready(h)
    socket.readyState = 2
    await h.clock.advance(1000)
    assert.equal(
        socket.sent.some((packet) => packet.op === 1),
        false
    )
    await h.clock.advance(2000)
    assert.equal(h.sockets.length, 2)
    await h.gateway.stop()
})
