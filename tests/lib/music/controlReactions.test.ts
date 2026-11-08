import assert from "node:assert/strict"
import { test } from "node:test"
import { dispatchControlReaction } from "../../../src/lib/music/controlReactions.js"
import { MusicAccessError } from "../../../src/lib/fluxer/access.js"
import { musicServiceHarness } from "../../test-support/musicServiceFakes.js"
import type { MusicAction } from "../../../src/shared/music-contract.js"

function harness() {
    const snapshot = musicServiceHarness().service.snapshot("1")
    const actions: MusicAction[] = []
    const writes: { method: string; path: string; body: unknown }[] = []
    let denied = false
    const dependencies = {
        botId: "8",
        matches: (guild: string, channel: string, message: string) =>
            guild === "1" && channel === "4" && message === "5",
        music: {
            snapshot: () => snapshot,
            execute: async (actor, action, options) => {
                assert.deepEqual(actor, { guildId: "1", userId: "9", textChannelId: "4" })
                assert.equal(options.expectedRevision, snapshot.revision)
                if (denied) throw new MusicAccessError(403, "Join the bot's voice channel first")
                actions.push(action)
                return snapshot
            },
        },
        rest: {
            request: async (method, path, options) => {
                writes.push({ method, path, body: options?.body })
                return undefined as any
            },
        },
    } satisfies Parameters<typeof dispatchControlReaction>[1]
    const event = (name = "⏯️") => ({
        guild_id: "1",
        channel_id: "4",
        message_id: "5",
        user_id: "9",
        emoji: { name },
    })
    return {
        snapshot,
        actions,
        writes,
        dependencies,
        event,
        deny: () => {
            denied = true
        },
    }
}

test("queue reactions dispatch all controls and reset the user's reaction for another click", async () => {
    const h = harness()
    for (const emoji of ["⏯️", "⏭️", "⏹️", "🔀", "🔁"])
        await dispatchControlReaction(h.event(emoji), h.dependencies)
    h.snapshot.status = "paused"
    await dispatchControlReaction(h.event("⏯"), h.dependencies)
    h.snapshot.repeatMode = "track"
    await dispatchControlReaction(h.event("🔁"), h.dependencies)
    h.snapshot.repeatMode = "queue"
    await dispatchControlReaction(h.event("🔁"), h.dependencies)
    assert.deepEqual(h.actions, [
        { type: "pause" },
        { type: "skip" },
        { type: "stop" },
        { type: "shuffle" },
        { type: "loop", mode: "track" },
        { type: "resume" },
        { type: "loop", mode: "queue" },
        { type: "loop", mode: "off" },
    ])
    assert.equal(h.writes.length, 8)
    assert.equal(h.writes[0].path, "/channels/4/messages/5/reactions/%E2%8F%AF%EF%B8%8F/9")
    assert.ok(h.writes.every((write) => write.method === "DELETE"))
})

test("unrelated, malformed, custom, bot and private reactions never control music", async () => {
    const h = harness()
    for (const event of [
        null,
        {},
        { ...h.event(), guild_id: undefined },
        { ...h.event(), message_id: "6" },
        { ...h.event(), channel_id: "6" },
        { ...h.event(), user_id: "8" },
        { ...h.event(), user_id: "../9" },
        { ...h.event(), member: { user: { bot: true } } },
        { ...h.event(), emoji: { name: "⏯️", id: "7" } },
        h.event("🍕"),
    ])
        await dispatchControlReaction(event, h.dependencies)
    assert.deepEqual(h.actions, [])
    assert.deepEqual(h.writes, [])
})

test("denied controls report safely and reset without changing playback", async () => {
    const h = harness()
    h.deny()
    await dispatchControlReaction(h.event(), h.dependencies)
    assert.deepEqual(h.actions, [])
    assert.deepEqual(h.writes[0].body, {
        content: "Join the bot's voice channel first",
        allowed_mentions: { parse: [] },
    })
    assert.equal(h.writes[1].method, "DELETE")
})

test("cleanup failure never replays a successful action", async () => {
    const h = harness()
    h.dependencies.rest.request = async () => {
        throw new Error("secret")
    }
    await dispatchControlReaction(h.event("⏭️"), h.dependencies)
    assert.deepEqual(h.actions, [{ type: "skip" }])
})

test("unexpected failures return generic feedback without exposing upstream details", async () => {
    const h = harness()
    h.dependencies.music.execute = async () => {
        throw new Error("private upstream token")
    }
    await dispatchControlReaction(h.event(), h.dependencies)
    assert.deepEqual(h.writes[0].body, {
        content: "Unable to complete the control. Please try again.",
        allowed_mentions: { parse: [] },
    })
    assert.equal(h.writes[1].method, "DELETE")
})

test("concurrent reaction toggles reject a stale revision through the real music service", async () => {
    const h = harness()
    const music = musicServiceHarness()
    const dependencies = { ...h.dependencies, music: music.service }
    await Promise.all([
        dispatchControlReaction(h.event("🔁"), dependencies),
        dispatchControlReaction(h.event("🔁"), dependencies),
    ])
    assert.equal(music.service.snapshot("1").repeatMode, "track")
    assert.equal(music.service.snapshot("1").revision, 1)
    assert.deepEqual(h.writes.find((write) => write.method === "POST")?.body, {
        content: "Music changed; refresh and try again",
        allowed_mentions: { parse: [] },
    })
    assert.equal(h.writes.filter((write) => write.method === "DELETE").length, 2)
    await music.service.shutdown()
})
