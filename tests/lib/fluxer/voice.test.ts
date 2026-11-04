import assert from "node:assert/strict"
import { test } from "node:test"
import { FluxerVoice } from "../../../src/lib/fluxer/voice.js"
import { FluxerClock } from "../../test-support/fluxerFakes.js"

function harness() {
    const clock = new FluxerClock(),
        sent: unknown[] = [],
        updates: string[] = []
    const voice = new FluxerVoice({
        send: (op, d) => {
            sent.push({ op, d })
        },
        schedule: clock.schedule,
        onDisconnect: (id) => updates.push(id),
    })
    return { voice, sent, updates, clock }
}
const grant = {
    guild_id: "1",
    channel_id: "2",
    connection_id: "conn",
    endpoint: "wss://voice.example",
    token: "secret",
    e2ee_key: "key",
}

test("joins only on a matching grant and leaves with the actual connection ID", async () => {
    const h = harness()
    const joined = h.voice.join("1", "2", new AbortController().signal)
    h.voice.handleDispatch({ t: "VOICE_SERVER_UPDATE", d: { ...grant, guild_id: "3" } })
    h.voice.handleDispatch({ t: "VOICE_SERVER_UPDATE", d: grant })
    assert.deepEqual(await joined, {
        endpoint: "wss://voice.example",
        token: "secret",
        connectionId: "conn",
        e2eeKey: "key",
    })
    await h.voice.leave("1")
    assert.deepEqual(h.sent.at(-1), {
        op: 4,
        d: { guild_id: "1", channel_id: null, connection_id: "conn" },
    })
    assert.equal(h.clock.pending, 0)
})

test("timed out joins reject after 15 seconds and cannot consume an uncorrelated late grant", async () => {
    const h = harness()
    const joined = h.voice.join("1", "2", new AbortController().signal)
    const rejected = assert.rejects(joined, /timed out/i)
    await h.clock.advance(15_000)
    await rejected
    await assert.rejects(h.voice.join("1", "2", new AbortController().signal), /settling/i)
    h.voice.handleDispatch({ t: "VOICE_SERVER_UPDATE", d: grant })
    assert.deepEqual(h.sent.at(-1), {
        op: 4,
        d: { guild_id: "1", channel_id: null, connection_id: "conn" },
    })
})

test("cancellation rejects immediately and late grants are disconnected rather than adopted", async () => {
    const h = harness(),
        controller = new AbortController()
    const joined = h.voice.join("1", "2", controller.signal)
    controller.abort()
    await assert.rejects(joined, { name: "AbortError" })
    h.voice.handleDispatch({ t: "VOICE_SERVER_UPDATE", d: grant })
    assert.equal(h.voice.channelId("1"), null)
    assert.deepEqual(h.sent.at(-1), {
        op: 4,
        d: { guild_id: "1", channel_id: null, connection_id: "conn" },
    })
    assert.equal(h.clock.pending, 0)
})

test("moved and disconnected connections notify consumers and fresh READY resets pending state", async () => {
    const h = harness()
    const joined = h.voice.join("1", "2", new AbortController().signal)
    h.voice.handleDispatch({ t: "VOICE_SERVER_UPDATE", d: grant })
    await joined
    h.voice.handleDispatch({
        t: "VOICE_STATE_UPDATE",
        d: { guild_id: "1", channel_id: "3", connection_id: "conn" },
    })
    assert.deepEqual(h.updates, ["1"])
    assert.equal(h.voice.channelId("1"), null)
    const pending = h.voice.join("4", "5", new AbortController().signal)
    h.voice.handleDispatch({ t: "READY", d: {} })
    await assert.rejects(pending, /session/i)
    assert.equal(h.clock.pending, 0)
})

test("rejects unsupported or malformed voice grants without revealing credentials", async () => {
    for (const patch of [{ p2p: true }, { endpoint: "file:///secret" }, { token: null }]) {
        const h = harness()
        const joined = h.voice.join("1", "2", new AbortController().signal)
        h.voice.handleDispatch({ t: "VOICE_SERVER_UPDATE", d: { ...grant, ...patch } })
        await assert.rejects(
            joined,
            (error: Error) => !error.message.includes("secret") && /grant/i.test(error.message)
        )
        assert.equal(h.voice.channelId("1"), null)
    }
})
