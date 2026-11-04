import assert from "node:assert/strict"
import { test } from "node:test"
import {
    SessionPersistence,
    parseMusicSessionSnapshot,
    type StoredMusicSession,
} from "../../../src/lib/music/sessionPersistence.js"
import {
    musicServiceHarness,
    musicActor as actor,
    musicTrack,
    settleMusic,
} from "../../test-support/musicServiceFakes.js"

function memoryStore() {
    const rows = new Map<string, StoredMusicSession>(),
        writes: string[] = []
    return {
        rows,
        writes,
        list: async () => [...rows.values()],
        save: async (row: StoredMusicSession) => {
            writes.push(row.guildId)
            rows.set(row.guildId, structuredClone(row))
        },
        delete: async (id: string) => {
            writes.push(id)
            rows.delete(id)
        },
    }
}

test("debounces canonical snapshots and restores the queue paused without opening voice", async () => {
    const h = musicServiceHarness(),
        store = memoryStore()
    const persistence = new SessionPersistence({
        service: h.service,
        store,
        schedule: h.clock.schedule,
        canRestore: async () => true,
    })
    await h.service.execute(actor, { type: "enqueue", tracks: [musicTrack("A"), musicTrack("B")] })
    await settleMusic()
    h.transports.get("1")!.position = 1234
    await h.service.execute(actor, { type: "volume", percent: 25 })
    await h.service.execute(actor, { type: "loop", mode: "queue" })
    assert.equal(store.writes.length, 0)
    await h.clock.advance(500)
    await persistence.flush()
    assert.equal(store.writes.length, 1)
    const serialized = JSON.stringify(store.rows.get("1"))
    assert.equal(serialized.includes("token"), false)
    assert.equal(serialized.includes("encoded"), false)
    await h.service.shutdown()
    await persistence.shutdown()
    const restored = musicServiceHarness()
    const next = new SessionPersistence({
        service: restored.service,
        store,
        schedule: restored.clock.schedule,
        canRestore: async () => true,
    })
    await next.restore()
    assert.equal(restored.service.snapshot("1").status, "paused")
    assert.equal(restored.service.snapshot("1").volume, 25)
    assert.equal(restored.service.snapshot("1").repeatMode, "queue")
    assert.equal(restored.service.snapshot("1").positionMs, 1234)
    assert.equal(restored.service.snapshot("1").queue[0].title, "B")
    assert.equal(restored.transports.size, 0)
    restored.deny()
    await assert.rejects(restored.service.execute(actor, { type: "resume" }))
    assert.equal(restored.transports.size, 0)
    restored.deny(false)
    await restored.service.execute(actor, { type: "resume" })
    await settleMusic()
    assert.equal(restored.prepares(), 1)
    assert.equal(restored.service.snapshot("1").positionMs, 1234)
    await restored.service.shutdown()
    await next.shutdown()
})

test("unknown and V1 snapshots are skipped without deleting or overwriting rows", async () => {
    const h = musicServiceHarness(),
        store = memoryStore()
    store.rows.set("1", {
        guildId: "1",
        voiceChannelId: "2",
        textChannelId: "3",
        snapshot: { version: 1 },
    })
    store.rows.set("11", {
        guildId: "11",
        voiceChannelId: "2",
        textChannelId: "3",
        snapshot: { version: 99 },
    })
    const persistence = new SessionPersistence({
        service: h.service,
        store,
        schedule: h.clock.schedule,
        canRestore: async () => true,
    })
    await persistence.restore()
    await h.service.shutdown()
    await persistence.shutdown()
    assert.equal(store.rows.size, 2)
    assert.equal(store.writes.length, 0)
    assert.equal(parseMusicSessionSnapshot({ version: 2, volume: NaN }), null)
})

test("shutdown flushes changes without a debounce delay and channel denial prevents restore", async () => {
    const h = musicServiceHarness(),
        store = memoryStore()
    const persistence = new SessionPersistence({
        service: h.service,
        store,
        schedule: h.clock.schedule,
        canRestore: async () => true,
    })
    await h.service.execute(actor, { type: "play", query: "A" })
    await settleMusic()
    h.transports.get("1")!.position = 5678
    await h.service.shutdown()
    await persistence.shutdown()
    assert.equal(store.rows.size, 1)
    assert.equal(parseMusicSessionSnapshot(store.rows.get("1")!.snapshot)?.positionMs, 5678)
    assert.equal(h.clock.pending, 0)
    const denied = musicServiceHarness()
    const next = new SessionPersistence({
        service: denied.service,
        store,
        schedule: denied.clock.schedule,
        canRestore: async () => false,
    })
    await next.restore()
    assert.equal(denied.service.snapshot("1").current, null)
    const writes = store.writes.length
    await denied.service.shutdown()
    await next.shutdown()
    assert.equal(store.writes.length, writes)
})

test("playing position is checkpointed at five seconds without waiting for another user action", async () => {
    const h = musicServiceHarness(),
        store = memoryStore()
    const persistence = new SessionPersistence({
        service: h.service,
        store,
        schedule: h.clock.schedule,
        canRestore: async () => true,
    })
    await h.service.execute(actor, { type: "play", query: "A" })
    await settleMusic()
    await h.clock.advance(500)
    h.transports.get("1")!.position = 4321
    await h.clock.advance(4500)
    assert.equal(parseMusicSessionSnapshot(store.rows.get("1")!.snapshot)?.positionMs, 4321)
    await h.service.shutdown()
    await persistence.shutdown()
})

test("a failed save retries the newest snapshot rather than overwriting a newer volume change", async () => {
    const h = musicServiceHarness(),
        store = memoryStore()
    let fail = true
    const persistence = new SessionPersistence({
        service: h.service,
        store: {
            ...store,
            save: async (row) => {
                if (fail) throw new Error("database unavailable")
                await store.save(row)
            },
        },
        schedule: h.clock.schedule,
        canRestore: async () => true,
    })
    await h.service.execute(actor, { type: "play", query: "A" })
    await settleMusic()
    await h.clock.advance(500)
    await h.service.execute(actor, { type: "volume", percent: 60 })
    fail = false
    await h.clock.advance(1000)
    assert.equal(parseMusicSessionSnapshot(store.rows.get("1")!.snapshot)?.volume, 60)
    await h.service.shutdown()
    await persistence.shutdown()
})
