import assert from "node:assert/strict"
import { test, mock } from "node:test"
const requests: { path: string; options?: { method?: string; body?: string } }[] = []
let status = 200,
    failure = false
mock.module("@/server/fetch-bot-api", {
    namedExports: {
        serverFetchBot: async (path: string, options?: { method?: string; body?: string }) => {
            requests.push({ path, options })
            if (failure) throw new Error("credential in upstream URL")
            return Response.json(
                status === 200
                    ? { ok: true, data: {} }
                    : {
                          ok: false,
                          error: {
                              error: status === 401 ? "Sign in with Fluxer" : "Access denied",
                          },
                      },
                { status }
            )
        },
    },
})
const actions = await import("../../../src/web/server/music.actions.js")
const playlists = await import("../../../src/web/server/playlists.actions.js")
test("music actions send native payloads, stable entry IDs and revisions without browser actor IDs", async () => {
    await actions.mutateMusicAction("1", { type: "volume", percent: 35 }, 4)
    assert.deepEqual(JSON.parse(requests.at(-1)!.options!.body!), {
        action: "volume",
        percent: 35,
        revision: 4,
    })
    for (const action of [
        { type: "pause" },
        { type: "resume" },
        { type: "skip" },
        { type: "stop" },
        { type: "leave" },
        { type: "seek", positionMs: 2000 },
        { type: "loop", mode: "queue" },
        { type: "shuffle" },
    ] as const) {
        await actions.mutateMusicAction("1", action, 5)
        assert.equal(JSON.parse(requests.at(-1)!.options!.body!).action, action.type)
    }
    await actions.mutateMusicAction("1", { type: "remove", entryId: "duplicate-row" }, 6)
    assert.equal(requests.at(-1)!.path, "/api/guilds/1/queue/duplicate-row")
    await actions.mutateMusicAction("1", { type: "move", entryId: "duplicate-row", toIndex: 1 }, 7)
    assert.deepEqual(JSON.parse(requests.at(-1)!.options!.body!), { toIndex: 1, revision: 7 })
    await actions.mutateMusicAction("1", { type: "clear" }, 8)
    assert.equal(requests.at(-1)!.options!.method, "DELETE")
    await actions.playMusicAction("1", "Some song", 9)
    assert.deepEqual(JSON.parse(requests.at(-1)!.options!.body!), {
        query: "Some song",
        revision: 9,
    })
    assert.equal((await actions.getMusicStateAction("../evil")).ok, false)
})
test("server actions preserve session/ownership denials and sanitize unexpected transport errors", async () => {
    status = 401
    assert.deepEqual(await actions.getMusicStateAction("1"), {
        ok: false,
        error: "Sign in with Fluxer",
    })
    status = 403
    assert.deepEqual(await playlists.getPlaylistAction(1), { ok: false, error: "Access denied" })
    status = 200
    failure = true
    const failed = await actions.getMusicStateAction("1")
    assert.equal(failed.ok, false)
    if (failed.ok === false) assert.doesNotMatch(failed.error, /credential|upstream/)
    failure = false
    await playlists.movePlaylistTrackAction(1, 44, 2)
    assert.equal(requests.at(-1)!.path, "/api/playlists/1/tracks/44")
    assert.deepEqual(JSON.parse(requests.at(-1)!.options!.body!), { to: 2 })
})
