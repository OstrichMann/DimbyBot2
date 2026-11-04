import assert from "node:assert/strict"
import { test } from "node:test"
import {
    musicServiceHarness,
    musicActor as actor,
    musicTrack,
    deferred,
    settleMusic,
} from "../../test-support/musicServiceFakes.js"
import { MusicError } from "../../../src/lib/music/musicService.js"
import { MusicAccessError } from "../../../src/lib/fluxer/access.js"
import type { MusicAction } from "../../../src/shared/music-contract.js"

test("play, pause/resume, seek and volume use one native session with actual playback duration", async () => {
    const h = musicServiceHarness()
    await h.service.execute(actor, { type: "play", query: "A" })
    await settleMusic()
    assert.equal(h.service.snapshot("1").current?.title, "A")
    assert.equal(h.service.snapshot("1").durationMs, 101000)
    await h.service.execute(actor, { type: "pause" })
    assert.equal(h.service.snapshot("1").status, "paused")
    await h.service.execute(actor, { type: "resume" })
    assert.equal(h.service.snapshot("1").status, "playing")
    await h.service.execute(actor, { type: "volume", percent: 35 })
    assert.equal(h.transports.get("1")!.volume, 35)
    await h.service.execute(actor, { type: "seek", positionMs: 5000 })
    await settleMusic()
    assert.equal(h.service.snapshot("1").positionMs, 5000)
    assert.equal(h.prepares(), 2)
    await h.service.shutdown()
})

test("queue edits use entry IDs, preserve current on shuffle/clear and isolate guilds", async () => {
    const h = musicServiceHarness()
    await h.service.execute(actor, {
        type: "enqueue",
        tracks: [musicTrack("A"), musicTrack("B"), musicTrack("B"), musicTrack("C")],
    })
    await settleMusic()
    const queue = h.service.snapshot("1").queue
    assert.notEqual(queue[0].entryId, queue[1].entryId)
    await h.service.execute(actor, { type: "move", entryId: queue[2].entryId, toIndex: 0 })
    assert.deepEqual(
        h.service.snapshot("1").queue.map((track) => track.title),
        ["C", "B", "B"]
    )
    await h.service.execute(actor, { type: "remove", entryId: queue[0].entryId })
    await assert.rejects(
        h.service.execute(actor, { type: "remove", entryId: queue[0].entryId }),
        (e) => e instanceof MusicError && e.status === 404
    )
    await h.service.execute(actor, { type: "shuffle" })
    assert.equal(h.service.snapshot("1").current?.title, "A")
    await h.service.execute({ ...actor, guildId: "11" }, { type: "play", query: "Other" })
    await settleMusic()
    await h.service.execute(actor, { type: "clear" })
    assert.equal(h.service.snapshot("1").queue.length, 0)
    assert.equal(h.service.snapshot("1").current?.title, "A")
    assert.equal(h.service.snapshot("11").current?.title, "Other")
    await h.service.shutdown()
})

test("track/queue loop and explicit skip advance once without stale completion affecting a successor", async () => {
    const h = musicServiceHarness()
    await h.service.execute(actor, { type: "enqueue", tracks: [musicTrack("A"), musicTrack("B")] })
    await settleMusic()
    await h.service.execute(actor, { type: "loop", mode: "track" })
    h.transports.get("1")!.finish()
    await settleMusic()
    assert.equal(h.service.snapshot("1").current?.title, "A")
    assert.equal(h.transports.get("1")!.plays.length, 2)
    await h.service.execute(actor, { type: "loop", mode: "queue" })
    await h.service.execute(actor, { type: "skip" })
    await settleMusic()
    assert.equal(h.service.snapshot("1").current?.title, "B")
    assert.equal(h.service.snapshot("1").queue[0].title, "A")
    h.transports.get("1")!.finish(0)
    await settleMusic()
    assert.equal(h.service.snapshot("1").current?.title, "B")
    await h.service.shutdown()
})

test("accepted searches commit in order even when their results arrive in reverse order", async () => {
    const h = musicServiceHarness(),
        a = deferred<{ kind: "search"; tracks: ReturnType<typeof musicTrack>[] }>(),
        b = deferred<{ kind: "search"; tracks: ReturnType<typeof musicTrack>[] }>()
    h.loads.set("A", a)
    h.loads.set("B", b)
    const first = h.service.execute(actor, { type: "play", query: "A" }),
        second = h.service.execute(actor, { type: "play", query: "B" })
    b.resolve({ kind: "search", tracks: [musicTrack("B")] })
    await settleMusic()
    assert.equal(h.service.snapshot("1").current, null)
    a.resolve({ kind: "search", tracks: [musicTrack("A")] })
    await Promise.all([first, second])
    await settleMusic()
    assert.equal(h.service.snapshot("1").current?.title, "A")
    assert.equal(h.service.snapshot("1").queue[0].title, "B")
    await h.service.shutdown()
})

test("stop cancels an uncooperative pending search and a late result cannot restart audio", async () => {
    const h = musicServiceHarness(),
        pending = deferred<{ kind: "search"; tracks: ReturnType<typeof musicTrack>[] }>()
    h.loads.set("slow", pending)
    const loading = h.service.execute(actor, { type: "play", query: "slow" })
    const rejected = assert.rejects(loading, { name: "AbortError" })
    await settleMusic()
    await h.service.execute(actor, { type: "stop" })
    await rejected
    await h.service.execute(actor, { type: "play", query: "New" })
    await settleMusic()
    pending.resolve({ kind: "search", tracks: [musicTrack("Old")] })
    await settleMusic()
    assert.equal(h.service.snapshot("1").current?.title, "New")
    assert.equal(h.service.snapshot("1").queue.length, 0)
    await h.service.execute(actor, { type: "leave" })
    assert.equal(h.service.snapshot("1").connected, false)
    assert.equal(h.service.snapshot("1").current, null)
    await h.service.shutdown()
})

test("denied actors, invalid bounds and stream seeks cannot mutate music state", async () => {
    const h = musicServiceHarness()
    h.deny()
    await assert.rejects(h.service.execute(actor, { type: "play", query: "A" }), MusicAccessError)
    h.deny(false)
    await h.service.execute(actor, {
        type: "enqueue",
        tracks: [{ ...musicTrack("Live"), isStream: true }],
    })
    await settleMusic()
    for (const action of [
        { type: "volume", percent: -1 },
        { type: "volume", percent: 101 },
        { type: "volume", percent: NaN },
        { type: "seek", positionMs: -1 },
        { type: "seek", positionMs: Infinity },
        { type: "seek", positionMs: 10 },
        { type: "move", entryId: "missing", toIndex: -1 },
        { type: "loop", mode: "wrong" },
    ] as MusicAction[])
        await assert.rejects(
            h.service.execute(actor, action),
            (e) => e instanceof MusicError && e.status === 400
        )
    assert.equal(h.service.snapshot("1").volume, 100)
    assert.equal(h.service.snapshot("1").current?.title, "Live")
    await h.service.shutdown()
})

test("permission loss suspends audio without deleting queue; empty voice timeout is canceled on rejoin", async () => {
    const h = musicServiceHarness()
    await h.service.execute(actor, { type: "enqueue", tracks: [musicTrack("A"), musicTrack("B")] })
    await settleMusic()
    h.listeners(false)
    await h.service.onPlatformChange("1")
    await h.clock.advance(119000)
    assert.equal(h.service.snapshot("1").connected, true)
    h.listeners(true)
    await h.service.onPlatformChange("1")
    await h.clock.advance(2000)
    assert.equal(h.service.snapshot("1").connected, true)
    h.denyBot()
    await h.service.onPlatformChange("1")
    assert.equal(h.service.snapshot("1").status, "paused")
    assert.equal(h.service.snapshot("1").connected, false)
    assert.equal(h.service.snapshot("1").queue[0].title, "B")
    await h.service.shutdown()
})

test("empty voice timeout disconnects while retaining a paused recoverable queue", async () => {
    const h = musicServiceHarness()
    await h.service.execute(actor, { type: "play", query: "A" })
    await settleMusic()
    h.listeners(false)
    await h.service.onPlatformChange("1")
    await h.clock.advance(120000)
    await settleMusic()
    assert.equal(h.service.snapshot("1").connected, false)
    assert.equal(h.service.snapshot("1").status, "paused")
    assert.equal(h.service.snapshot("1").current?.title, "A")
    await h.service.shutdown()
})

test("stop during connection removes partial voice membership and permits a fresh successor", async () => {
    const h = musicServiceHarness(),
        gate = deferred<void>()
    h.setConnectGate(gate)
    await h.service.execute(actor, { type: "play", query: "A" })
    await settleMusic()
    assert.equal(h.voice.has("1"), true)
    assert.equal(h.service.snapshot("1").connected, false)
    await h.service.execute(actor, { type: "stop" })
    assert.equal(h.voice.has("1"), false)
    h.setConnectGate()
    await h.service.execute(actor, { type: "play", query: "B" })
    await settleMusic()
    gate.resolve()
    await settleMusic()
    assert.equal(h.service.snapshot("1").current?.title, "B")
    assert.equal(h.service.snapshot("1").connected, true)
    await h.service.shutdown()
})

test("bad tracks and oversized batches are atomic; requester identity is set by the authenticated actor", async () => {
    const h = musicServiceHarness()
    await assert.rejects(
        h.service.execute(actor, {
            type: "enqueue",
            tracks: [musicTrack("A"), { ...musicTrack("B"), uri: "file:///etc/passwd" }],
        }),
        (e) => e instanceof MusicError && e.status === 400
    )
    assert.equal(h.service.snapshot("1").current, null)
    await assert.rejects(
        h.service.execute(actor, {
            type: "enqueue",
            tracks: Array.from({ length: 1001 }, () => musicTrack("A")),
        }),
        (e) => e instanceof MusicError && e.status === 400
    )
    const input = { ...musicTrack("A"), requesterId: "88", token: "never-serialize" }
    await h.service.execute(actor, { type: "enqueue", tracks: [input] })
    await settleMusic()
    assert.equal(h.service.snapshot("1").current?.requesterId, "9")
    assert.equal(JSON.stringify(h.service.snapshot("1")).includes("never-serialize"), false)
    await h.service.shutdown()
})

test("an off-mode completion becomes idle, and invalid current-track operations return not found", async () => {
    const h = musicServiceHarness()
    for (const action of [
        { type: "pause" },
        { type: "resume" },
        { type: "skip" },
        { type: "seek", positionMs: 0 },
    ] as MusicAction[])
        await assert.rejects(
            h.service.execute(actor, action),
            (e) => e instanceof MusicError && e.status === 404
        )
    await h.service.execute(actor, { type: "play", query: "A" })
    await settleMusic()
    h.transports.get("1")!.finish()
    await settleMusic()
    assert.equal(h.service.snapshot("1").current, null)
    assert.equal(h.service.snapshot("1").status, "idle")
    await h.service.shutdown()
    await assert.rejects(
        h.service.execute(actor, { type: "play", query: "B" }),
        (e) => e instanceof MusicError && e.status === 503
    )
})

test("leave while a paused source is being prepared closes it without handing it to a successor transport", async () => {
    const h = musicServiceHarness(),
        prepare = deferred<void>(),
        pause = deferred<void>()
    h.setPrepareGate(prepare)
    await h.service.execute(actor, { type: "play", query: "A" })
    await settleMusic()
    await h.service.execute(actor, { type: "pause" })
    const transport = h.transports.get("1")!
    transport.pauseGate = pause
    prepare.resolve()
    await settleMusic()
    assert.equal(h.prepares(), 1)
    await h.service.execute(actor, { type: "leave" })
    pause.resolve()
    await settleMusic()
    assert.equal(transport.plays.length, 0)
    assert.equal(h.closes(), 1)
    await h.service.shutdown()
})

test("now playing links the actual playback URL while preserving catalog source identity for recovery", async () => {
    const h = musicServiceHarness()
    const uri = "https://open.spotify.com/track/0123456789012345678901"
    await h.service.execute(actor, {
        type: "enqueue",
        tracks: [
            {
                ...musicTrack("Catalog"),
                source: "spotify",
                sourceId: "0123456789012345678901",
                uri,
            },
        ],
    })
    await settleMusic()
    assert.equal(h.service.snapshot("1").current?.uri, uri)
    assert.equal(h.service.snapshot("1").playbackUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    await h.service.shutdown()
})

test("stale Dashboard revisions cannot mutate or cancel a newer playback generation", async () => {
    const h = musicServiceHarness()
    const initial = h.service.snapshot("1").revision
    await h.service.execute(actor, { type: "volume", percent: 25 }, { expectedRevision: initial })
    const fresh = h.service.snapshot("1")
    await assert.rejects(
        h.service.execute(actor, { type: "stop" }, { expectedRevision: initial }),
        (e) => e instanceof MusicError && e.status === 409
    )
    assert.equal(h.service.snapshot("1").revision, fresh.revision)
    assert.equal(h.service.snapshot("1").volume, 25)
    await assert.rejects(
        h.service.execute(actor, { type: "volume", percent: 30 }, { expectedRevision: -1 }),
        (e) => e instanceof MusicError && e.status === 400
    )
})
