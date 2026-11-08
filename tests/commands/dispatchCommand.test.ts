import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { FluxerRestError } from "../../src/lib/fluxer/rest.js"
import { dispatchCommand } from "../../src/commands/dispatchCommand.js"
import type { CommandDependencies } from "../../src/commands/context.js"
import type { FluxerMessage } from "../../src/lib/fluxer/entities.js"
import { MusicError } from "../../src/lib/music/musicService.js"
import { MusicAccessError } from "../../src/lib/fluxer/access.js"
import { musicServiceHarness, musicTrack } from "../test-support/musicServiceFakes.js"

function harness() {
    const actions: unknown[] = [],
        replies: { path: string; body: any }[] = [],
        deletions: string[] = [],
        playlists: any[] = []
    let configured: string | null = "4",
        forbidden = false,
        failedReply = false,
        unexpected = false
    const snapshot = musicServiceHarness().service.snapshot("1")
    const deps: CommandDependencies = {
        prefix: "!",
        music: {
            snapshot: () => snapshot,
            execute: async (_actor, action) => {
                actions.push(action)
                if (unexpected) throw new Error("secret upstream URL")
                return snapshot
            },
            requiredAccess: () => ({ level: "control", channelId: undefined }),
        },
        playlists: {
            execute: async (_user, action) => {
                playlists.push(action)
                return { kind: "list", playlists: [] }
            },
        },
        access: {
            authorizeMusic: async () => {
                if (forbidden) throw new MusicAccessError(403, "Manage Guild permission required")
                return { guildId: "1", userId: "2", voiceChannelId: null }
            },
        },
        rest: {
            request: async (method, path, options) => {
                if (method === "DELETE") {
                    deletions.push(path)
                    return undefined as any
                }
                replies.push({ path, body: options?.body })
                if (failedReply) throw new Error("ambiguous write")
                return { id: "10" } as any
            },
        },
        controlChannel: () => configured,
        setControlChannel: async (_guild, channel) => {
            configured = channel
        },
        validateControlChannel: async () => {},
        onError: () => {},
    }
    const message: FluxerMessage = {
        id: "3",
        guildId: "1",
        channelId: "4",
        authorId: "2",
        content: "",
        bot: false,
        webhook: false,
    }
    return {
        deps,
        actions,
        replies,
        deletions,
        playlists,
        snapshot,
        send: (content: string, extra: Partial<FluxerMessage> = {}) =>
            dispatchCommand({ ...message, content, ...extra }, deps),
        forbid: () => {
            forbidden = true
        },
        failReply: () => {
            failedReply = true
        },
        unexpected: () => {
            unexpected = true
        },
    }
}

test("prefix play preserves query; control text queues; explicit unknown commands only reply", async () => {
    const h = harness()
    await h.send("!play Can't Stop  live")
    await h.send("ordinary music search")
    await h.send("!nonexistent song")
    assert.deepEqual(h.actions, [
        { type: "play", query: "Can't Stop  live" },
        { type: "play", query: "ordinary music search" },
    ])
    assert.match(h.replies[2].body.content, /Unknown command/)
    h.deps.prefix = "?"
    await h.send("?play custom prefix")
    assert.deepEqual(h.actions[2], { type: "play", query: "custom prefix" })
    await h.send(" ?play unrelated", { channelId: "5" })
    assert.equal(h.replies.length, 4)
})

test("bot, webhook and DM messages are ignored", async () => {
    const h = harness()
    await h.send("!play song", { bot: true })
    await h.send("!play song", { webhook: true })
    await h.send("!play song", { guildId: null })
    assert.equal(h.replies.length, 0)
    assert.equal(h.actions.length, 0)
})

test("bad seek, volume, loop and queue indexes reply without music mutations", async () => {
    const h = harness()
    for (const text of [
        "!seek 1:90",
        "!volume 101",
        "!volume 0x10",
        "!loop forever",
        "!remove 0",
        "!move 1 2",
        "!seek",
        '!playlist create "unclosed',
    ])
        await h.send(text)
    assert.equal(h.actions.length, 0)
    assert.equal(h.replies.length, 8)
    for (const reply of h.replies) assert.ok(reply.body.content)
})

test("music commands translate positions to stable entry IDs and expose actual playback link", async () => {
    const h = harness()
    h.snapshot.queue = [{ entryId: "duplicate-row", title: "Queued" } as any]
    h.snapshot.current = { title: "Current", uri: "https://catalog.invalid/track" } as any
    h.snapshot.playbackUrl = "https://youtu.be/abcdefghijk"
    for (const command of [
        "pause",
        "resume",
        "skip",
        "stop",
        "leave",
        "clear",
        "shuffle",
        "seek 1:02",
        "volume 50",
        "loop queue",
        "remove 1",
        "move 1 1",
        "queue",
        "nowplaying",
        "help",
    ])
        await h.send(`!${command}`)
    assert.deepEqual(h.actions.slice(7), [
        { type: "seek", positionMs: 62000 },
        { type: "volume", percent: 50 },
        { type: "loop", mode: "queue" },
        { type: "remove", entryId: "duplicate-row" },
        { type: "move", entryId: "duplicate-row", toIndex: 0 },
    ])
    assert.match(h.replies[12].body.content, /1\. Queued/)
    assert.match(h.replies[13].body.content, /https:\/\/youtu.be\/abcdefghijk/)
    assert.match(h.replies[14].body.content, /playlist/)
    assert.equal(h.replies.length, 15)
})

test("quoted playlist arguments and configure authorization are enforced", async () => {
    const h = harness()
    await h.send('!playlist create "My Music"')
    await h.send('!playlist add "My Music" a song')
    assert.deepEqual(h.playlists, [
        { type: "create", name: "My Music" },
        { type: "add", playlist: "My Music", query: "a song" },
    ])
    h.forbid()
    await h.send("!control-channel off")
    assert.equal(h.deps.controlChannel("1"), "4")
    assert.match(h.replies[2].body.content, /Manage Guild/)
})

test("replies suppress mentions, sanitize failures, and never retry ambiguous message writes", async () => {
    const h = harness()
    h.unexpected()
    await h.send("!play @everyone")
    assert.deepEqual(h.replies[0].body.allowed_mentions, { parse: [] })
    assert.doesNotMatch(h.replies[0].body.content, /secret|upstream/)
    h.failReply()
    await h.send("!help")
    assert.equal(h.replies.length, 2)
    assert.ok(MusicError)
})

test("control channel configuration validates target and supports disabling", async () => {
    const h = harness()
    const checked: string[] = []
    h.deps.validateControlChannel = async (_actor, id) => {
        checked.push(id)
    }
    await h.send("!control-channel 6")
    assert.equal(h.deps.controlChannel("1"), "6")
    assert.deepEqual(checked, ["6"])
    assert.match(h.replies[0].body.content, /set/)
    await h.send("!control-channel off")
    assert.equal(h.deps.controlChannel("1"), null)
    assert.match(h.replies[1].body.content, /disabled/)
    await h.send("!control-channel invalid")
    assert.match(h.replies[2].body.content, /text channel ID/)
})

test("playlist commands map quoted references and playlist play queues returned tracks", async () => {
    const h = harness()
    await h.send("!playlist list")
    await h.send('!playlist view "My List"')
    await h.send('!playlist rename "My List" "New List"')
    await h.send('!playlist remove "My List" 2')
    await h.send('!playlist move "My List" 2 1')
    await h.send('!playlist delete "My List"')
    assert.deepEqual(h.playlists, [
        { type: "list" },
        { type: "view", playlist: "My List" },
        { type: "rename", playlist: "My List", name: "New List" },
        { type: "remove", playlist: "My List", position: 2 },
        { type: "move", playlist: "My List", from: 2, to: 1 },
        { type: "delete", playlist: "My List" },
    ])
    h.deps.playlists.execute = async () => ({
        kind: "enqueue",
        tracks: [],
        playlist: { name: "My List" } as any,
    })
    await h.send('!playlist play "My List"')
    assert.deepEqual(h.actions, [{ type: "enqueue", tracks: [] }])
    assert.match(h.replies.at(-1)!.body.content, /Queued 0 tracks from My List/)
    await h.send('!playlist unknown "My List"')
    assert.match(h.replies.at(-1)!.body.content, /Use playlist/)
})

test("queue index commands authorize before revealing whether an entry exists", async () => {
    const h = harness()
    h.forbid()
    await h.send("!remove 1")
    assert.match(h.replies[0].body.content, /Manage Guild/)
    assert.equal(h.actions.length, 0)
})

test("remove and move on a restored session authorize queue access before reading indexes", async () => {
    const service = musicServiceHarness()
    service.service.restore({
        guildId: "1",
        voiceChannelId: "2",
        textChannelId: "3",
        snapshot: {
            version: 2,
            current: musicTrack("A"),
            queue: [musicTrack("B")],
            positionMs: 4000,
            volume: 100,
            repeatMode: "off",
            paused: true,
        },
    })
    const h = harness()
    let authorized = false
    const calls: { action: string; channelId?: string }[] = []
    h.deps.music.requiredAccess = (guildId, action) =>
        service.service.requiredAccess(guildId, action)
    h.deps.music.snapshot = (guildId: string) => {
        assert.equal(authorized, true)
        return service.service.snapshot(guildId)
    }
    h.deps.music.execute = (actor, action) => service.service.execute(actor, action)
    h.deps.access.authorizeMusic = async (_actor, action, channelId) => {
        calls.push({ action, channelId })
        if (action !== "queue") throw new MusicAccessError(403, "No active voice session")
        authorized = true
        return { guildId: "1", userId: "9", voiceChannelId: channelId ?? null }
    }
    await h.send("!remove 1", { authorId: "9" })
    assert.deepEqual(calls, [{ action: "queue", channelId: "2" }])
    assert.deepEqual(service.authorizations, [{ action: "queue", channelId: "2" }])
    assert.equal(service.service.snapshot("1").queue.length, 0)
    authorized = false
    await h.send("!move 1 1", { authorId: "9" })
    assert.deepEqual(calls[1], { action: "queue", channelId: "2" })
    assert.match(h.replies.at(-1)!.body.content, /Queue entry not found/)
    await service.service.shutdown()
})

test("unknown prefix commands outside the control channel are ignored, not answered", async () => {
    const h = harness()
    await h.send("!rank", { channelId: "5" })
    await h.send("!!!", { channelId: "5" })
    assert.equal(h.replies.length, 0)
    await h.send("!skip", { channelId: "5" })
    assert.equal(h.replies.length, 1)
})

test("play queries may start with an apostrophe; other commands explain unclosed quotes", async () => {
    const h = harness()
    await h.send("!play 'Til Tuesday")
    assert.deepEqual(h.actions, [{ type: "play", query: "'Til Tuesday" }])
    await h.send('!playlist view "Road trip')
    assert.equal(h.replies[1].body.content, "Close the quoted argument")
    assert.equal(h.playlists.length, 0)
})

test("control queries and commands are removed after processing; feedback expires after five seconds", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const h = harness()
    for (const query of ["a song", "!pause", "!unknown", "!volume 101"]) {
        h.deletions.length = 0
        await h.send(query)
        assert.deepEqual(h.deletions, ["/channels/4/messages/3"])
        t.mock.timers.tick(4999)
        await setImmediate()
        assert.equal(h.deletions.length, 1)
        t.mock.timers.tick(1)
        await setImmediate()
        assert.deepEqual(h.deletions, ["/channels/4/messages/3", "/channels/4/messages/10"])
    }
})

test("cleanup never deletes messages outside the control channel or ignored authors", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const h = harness()
    await h.send("!play song", { channelId: "5" })
    await h.send("!play song", { bot: true })
    await h.send("!play song", { webhook: true })
    await h.send("!play song", { guildId: null })
    t.mock.timers.tick(5000)
    await setImmediate()
    assert.deepEqual(h.deletions, [])
})

test("control cleanup survives command errors and ambiguous reply failures without resending", async () => {
    const h = harness()
    h.unexpected()
    h.failReply()
    await h.send("!play song")
    assert.deepEqual(h.deletions, ["/channels/4/messages/3"])
    assert.equal(h.replies.length, 1)
})

test("query deletion failures do not prevent feedback cleanup; missing messages are harmless", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const h = harness()
    const errors: string[] = []
    h.deps.onError = (message) => errors.push(message)
    const request = h.deps.rest.request
    h.deps.rest.request = async (method, path, options) => {
        if (method === "DELETE") {
            h.deletions.push(path)
            throw new FluxerRestError(path.endsWith("/3") ? 403 : 404)
        }
        return request(method, path, options)
    }
    await h.send("!help")
    assert.deepEqual(errors, ["Fluxer control message cleanup failed"])
    t.mock.timers.tick(5000)
    await setImmediate()
    assert.deepEqual(h.deletions, ["/channels/4/messages/3", "/channels/4/messages/10"])
    assert.equal(errors.length, 1)
})

test("cleanup uses the original control channel when configuration changes", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const h = harness()
    await h.send("!control-channel 6")
    t.mock.timers.tick(5000)
    await setImmediate()
    assert.deepEqual(h.deletions, ["/channels/4/messages/3", "/channels/4/messages/10"])
})
