import assert from "node:assert/strict"
import { test } from "node:test"
import {
    PlaylistService,
    type NativePlaylistRepository,
} from "../../../src/lib/music/playlistService.js"
import {
    PlaylistNotFoundError,
    PlaylistDuplicateNameError,
} from "../../../src/repositories/playlistRepository.js"
import { MusicError } from "../../../src/lib/music/musicService.js"
import { musicTrack } from "../../test-support/musicServiceFakes.js"
import type { PlaylistData } from "../../../src/types/index.js"

function harness() {
    const lists = new Map<number, PlaylistData>()
    let next = 0,
        denyWrite = false
    const owned = (user: string, id: number) => {
        const row = lists.get(id)
        if (!row || row.userId !== user || denyWrite) throw new PlaylistNotFoundError()
        return row
    }
    const repository: NativePlaylistRepository = {
        list: async (user) =>
            [...lists.values()]
                .filter((row) => row.userId === user)
                .map((row) => ({
                    id: row.id,
                    name: row.name,
                    trackCount: row.tracks.length,
                    totalDuration: 0,
                    createdAt: row.createdAt,
                })),
        get: async (user, ref) =>
            [...lists.values()].find(
                (row) =>
                    row.userId === user &&
                    (typeof ref === "number" ? row.id === ref : row.name === ref)
            ) ?? null,
        create: async (user, name) => {
            if ([...lists.values()].some((row) => row.userId === user && row.name === name))
                throw new PlaylistDuplicateNameError(name)
            const row = {
                id: ++next,
                name,
                userId: user,
                tracks: [],
                createdAt: new Date(0),
                updatedAt: new Date(0),
            }
            lists.set(row.id, row)
            return row
        },
        rename: async (user, id, name) => {
            owned(user, id).name = name
        },
        delete: async (user, id) => {
            owned(user, id)
            lists.delete(id)
        },
        add: async (user, id, tracks) => {
            const row = owned(user, id)
            for (const track of tracks)
                row.tracks.push({
                    ...track,
                    id: row.tracks.length + 1,
                    thumbnailUrl: track.thumbnailUrl ?? null,
                    position: row.tracks.length + 1,
                })
        },
        remove: async (user, id, trackId) => {
            const row = owned(user, id)
            row.tracks.splice(
                row.tracks.findIndex((track) => track.id === trackId),
                1
            )
        },
        move: async (user, id, trackId, to) => {
            const row = owned(user, id)
            const [track] = row.tracks.splice(
                row.tracks.findIndex((track) => track.id === trackId),
                1
            )
            row.tracks.splice(to - 1, 0, track)
        },
    }
    const service = new PlaylistService({
        repository,
        resolver: { load: async () => ({ kind: "search", tracks: [musicTrack("Song")] }) },
    })
    return {
        service,
        lists,
        denyWrite: () => {
            denyWrite = true
        },
    }
}

test("playlist create/list/view/rename/add/reorder/remove/enqueue/delete stay owner-scoped", async () => {
    const h = harness()
    const created = await h.service.execute("9", { type: "create", name: "My List" })
    assert.equal(created.kind, "playlist")
    assert.equal((await h.service.execute("9", { type: "list" })).kind, "list")
    await h.service.execute("9", { type: "add", playlist: 1, query: "Song" })
    await h.service.execute("9", { type: "addTracks", playlist: 1, tracks: [musicTrack("Other")] })
    await h.service.execute("9", { type: "move", playlist: 1, from: 1, to: 2 })
    await h.service.execute("9", { type: "remove", playlist: 1, position: 1 })
    await h.service.execute("9", { type: "rename", playlist: 1, name: "New Name" })
    const queued = await h.service.execute("9", { type: "enqueue", playlist: "New Name" })
    assert.equal(queued.kind === "enqueue" ? queued.tracks[0].title : null, "Song")
    assert.equal((await h.service.execute("9", { type: "view", playlist: 1 })).kind, "playlist")
    await h.service.execute("9", { type: "delete", playlist: 1 })
    assert.equal(h.lists.size, 0)
})

test("cross-user access, duplicate names, invalid reorder and ownership races fail safely", async () => {
    const h = harness()
    await h.service.execute("9", { type: "create", name: "Private" })
    await assert.rejects(
        h.service.execute("8", { type: "view", playlist: 1 }),
        (e) => e instanceof MusicError && e.status === 404
    )
    await assert.rejects(
        h.service.execute("9", { type: "create", name: "Private" }),
        (e) => e instanceof MusicError && e.status === 409
    )
    await assert.rejects(
        h.service.execute("9", { type: "move", playlist: 1, from: 0, to: 2 }),
        (e) => e instanceof MusicError && e.status === 400
    )
    h.denyWrite()
    await assert.rejects(
        h.service.execute("9", { type: "addTracks", playlist: 1, tracks: [musicTrack("Song")] }),
        (e) => e instanceof MusicError && e.status === 404
    )
    assert.equal(h.lists.get(1)!.tracks.length, 0)
})

test("duplicate track rows remain distinct and saved playlist enqueue needs no network lookup", async () => {
    const h = harness()
    await h.service.execute("9", { type: "create", name: "Duplicates" })
    await h.service.execute("9", {
        type: "addTracks",
        playlist: 1,
        tracks: [musicTrack("Song"), musicTrack("Song")],
    })
    const result = await h.service.execute("9", { type: "enqueue", playlist: 1 })
    assert.equal(result.kind, "enqueue")
    if (result.kind === "enqueue") {
        assert.equal(result.tracks.length, 2)
        assert.notEqual(result.tracks[0].entryId, result.tracks[1].entryId)
    }
})
