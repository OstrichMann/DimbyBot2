import assert from "node:assert/strict"
import { test } from "node:test"
import { FluxerEntities } from "../../../src/lib/fluxer/entities.js"
import { FluxerRest } from "../../../src/lib/fluxer/rest.js"
import type { FluxerDispatch, FluxerGateway } from "../../../src/lib/fluxer/gateway.js"
import type { RuntimeStorage } from "../../../src/repositories/nativeMusicStorage.js"
import { musicServiceHarness, settleMusic } from "../../test-support/musicServiceFakes.js"

const { default: BotClient } = await import("../../../src/lib/BotClient.js")

const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    setDebugEnabled: () => {},
    getDebugEnabled: () => false,
    getLogFilePath: () => null,
}
const endpoints = {
    api: "https://api.example/v1",
    gateway: "wss://gw.example",
    webapp: "https://chat.example",
    media: "https://media.example",
    cdn: "https://static.example",
}
test("native startup composes only music, ignores deferred command names, and flushes/cleans up at shutdown", async () => {
    const calls: string[] = [],
        messages: string[] = [],
        h = musicServiceHarness()
    let dispatch: (event: FluxerDispatch) => Promise<void>,
        ready = false,
        failProbe = false,
        hangPosts = false
    const releasePosts: Array<() => void> = []
    const settings = new Map<string, { channelId: string | null; messageId: string | null }>()
    const storage: RuntimeStorage = {
        start: async () => {
            calls.push("storage-start")
        },
        close: async () => {
            calls.push("storage-close")
        },
        settings: (guildId) => settings.get(guildId) ?? { channelId: null, messageId: null },
        setControlChannel: async (guildId, channelId) => {
            settings.set(guildId, { channelId, messageId: null })
        },
        saveMessageId: async () => {},
        sessions: {
            list: async () => [],
            save: async () => {
                calls.push("snapshot-save")
            },
            delete: async () => {},
        },
    }
    const env = {
        FLUXER_BOT_TOKEN: "raw-token",
        FLUXER_CLIENT_ID: "8",
        LAVALINK_ORIGIN: "http://localhost:2333",
        LAVALINK_PASSWORD: "metadata-password",
        INVIDIOUS_COMPANION_URL: "http://localhost:8282",
        INVIDIOUS_COMPANION_KEY: "0123456789abcdef",
    }
    const options = {
        env,
        storage,
        discover: async () => endpoints,
        resolver: {
            search: async () => [],
            load: async () => ({ kind: "empty" as const, tracks: [] }),
            prepare: async () => {
                throw new Error("No audio expected")
            },
        },
        createRest: () =>
            new FluxerRest(endpoints.api, "raw-token", {
                sleep: async () => {},
                fetchImpl: async (input, init) => {
                    const url = String(input)
                    assert.doesNotMatch(url, /discord/)
                    if (init?.method === "POST") {
                        messages.push(String(JSON.parse(init.body as string).content))
                        return Response.json({ id: "7" })
                    }
                    if (hangPosts)
                        return new Promise((resolve) => {
                            releasePosts.push(() => resolve(Response.json({ id: "8", bot: true })))
                        })
                    return Response.json({ id: "8", bot: true })
                },
            }),
        createGateway: (
            _endpoint: string,
            _token: string,
            dependencies: ConstructorParameters<typeof FluxerGateway>[2]
        ) => {
            dispatch = dependencies.onDispatch
            return {
                get ready() {
                    return ready
                },
                send: () => {},
                start: async () => {
                    ready = true
                    await dispatch({ t: "READY", d: { user: { id: "8" } } })
                    await dispatch({
                        t: "GUILD_CREATE",
                        d: { id: "1", properties: { name: "Test", owner_id: "9" } },
                    })
                },
                stop: async () => {
                    ready = false
                    calls.push("gateway-stop")
                },
            }
        },
        probeSources: async () => {
            if (failProbe) throw new Error("Source unavailable")
            calls.push("source-probe")
        },
        dispose: async () => {
            calls.push("sdk-dispose")
        },
    }
    const client = new BotClient(logger, options)
    assert.ok(client.entities instanceof FluxerEntities)
    await client.start()
    assert.equal(client.ready, true)
    await dispatch!({
        t: "MESSAGE_CREATE",
        d: { id: "3", guild_id: "1", channel_id: "4", author: { id: "9" }, content: "!help" },
    })
    await dispatch!({
        t: "MESSAGE_CREATE",
        d: { id: "5", guild_id: "1", channel_id: "4", author: { id: "9" }, content: "!countdown" },
    })
    await settleMusic()
    assert.match(messages[0], /playlist/)
    assert.equal(messages.length, 1, "deferred commands outside the control channel get no reply")
    assert.doesNotMatch(messages[0], /autoplay|round.robin|countdown|download|alert/i)
    settings.set("1", { channelId: "4", messageId: "5" })
    const originalExecute = client.music.execute.bind(client.music)
    const reactionActions: string[] = []
    client.music.execute = async (_actor, action) => {
        reactionActions.push(action.type)
        return client.music.snapshot("1")
    }
    await dispatch!({
        t: "MESSAGE_REACTION_ADD",
        d: {
            guild_id: "1",
            channel_id: "4",
            message_id: "5",
            user_id: "9",
            emoji: { name: "⏭️" },
        },
    })
    await dispatch!({
        t: "MESSAGE_REACTION_REMOVE",
        d: {
            guild_id: "1",
            channel_id: "4",
            message_id: "5",
            user_id: "9",
            emoji: { name: "⏭️" },
        },
    })
    await settleMusic()
    assert.deepEqual(reactionActions, ["skip"])
    client.music.execute = originalExecute
    settings.clear()
    let checks = 0,
        release: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    client.music.onPlatformChange = async () => {
        checks++
        await gate
    }
    for (let i = 0; i < 30; i++)
        await dispatch!({
            t: "VOICE_STATE_UPDATE",
            d: { guild_id: "1", user_id: "9", connection_id: "user", channel_id: "2" },
        })
    assert.equal(checks, 1, "permission checks coalesce while one is in flight")
    release!()
    await settleMusic()
    assert.equal(checks, 2, "one fresh check follows the coalesced changes")
    hangPosts = true
    for (let i = 0; i < 1000; i++)
        await dispatch!({
            t: "MESSAGE_CREATE",
            d: {
                id: String(i + 10),
                guild_id: "1",
                channel_id: "4",
                author: { id: "9" },
                content: "!play song",
            },
        })
    await settleMusic()
    const queued = messages.length
    await dispatch!({
        t: "MESSAGE_CREATE",
        d: {
            id: "2000",
            guild_id: "1",
            channel_id: "4",
            author: { id: "9" },
            content: "!skip",
        },
    })
    await settleMusic()
    assert.match(messages[queued] ?? "", /busy/i)
    assert.equal(messages.length, queued + 1)
    hangPosts = false
    for (const releasePost of releasePosts) releasePost()
    await settleMusic()
    await client.destroy()
    assert.equal(client.ready, false)
    assert.ok(calls.indexOf("gateway-stop") < calls.indexOf("storage-close"))
    assert.ok(calls.includes("sdk-dispose"))
    failProbe = true
    const failed = new BotClient(logger, options)
    await assert.rejects(failed.start(), /unavailable/i)
    assert.equal(failed.ready, false)
    await failed.destroy()
    failProbe = false
    await assert.rejects(
        new BotClient(logger, {
            ...options,
            env: { ...env, INVIDIOUS_COMPANION_KEY: "bad" },
        }).start(),
        /16/
    )
})
