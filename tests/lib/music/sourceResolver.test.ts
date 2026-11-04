import assert from "node:assert/strict"
import { test } from "node:test"
import { SourceResolver } from "../../../src/lib/music/sourceResolver.js"
import { LavalinkSearch } from "../../../src/lib/music/lavalinkSearch.js"

const youtube = {
    encoded: "never-public",
    info: {
        identifier: "dQw4w9WgXcQ",
        sourceName: "youtube",
        title: "Video",
        author: "Artist",
        uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        length: 120000,
        isStream: false,
    },
}
const catalog = {
    encoded: "catalog-only",
    info: {
        ...youtube.info,
        identifier: "0123456789012345678901",
        sourceName: "spotify",
        title: "Catalog title",
        author: "Catalog artist",
        uri: "https://open.spotify.com/track/0123456789012345678901",
    },
}

function harness() {
    const identifiers: string[] = [],
        prepared: string[] = []
    let kind = "search",
        tracks = [youtube],
        revision = 0
    const metadata = new LavalinkSearch({
        origin: "http://lavalink:2333",
        password: "secret",
        fetchImpl: async (input, init) => {
            const url = new URL(String(input))
            identifiers.push(url.searchParams.get("identifier")!)
            assert.equal(url.pathname, "/v4/loadtracks")
            assert.equal(new Headers(init?.headers).get("authorization"), "secret")
            return Response.json({
                loadType: kind,
                data:
                    kind === "playlist"
                        ? { tracks, info: { name: "Playlist" } }
                        : kind === "track"
                          ? tracks[0]
                          : tracks,
            })
        },
    })
    const resolver = new SourceResolver({
        metadata,
        companion: {
            prepare: async (videoId, signal) => {
                signal.throwIfAborted()
                prepared.push(videoId)
                const version = ++revision
                return {
                    input: (async function* () {
                        yield new Uint8Array([version])
                    })(),
                    durationMs: 150000,
                    playbackUrl: `https://www.youtube.com/watch?v=${videoId}`,
                    seekable: true,
                    close: async () => {},
                }
            },
        },
        media: {
            open: async () => {
                throw new Error("Unexpected media fetch")
            },
        },
    })
    return {
        resolver,
        identifiers,
        prepared,
        setCatalog: () => {
            tracks = [catalog]
            kind = "track"
        },
        setYoutube: () => {
            tracks = [youtube]
            kind = "search"
        },
    }
}

test("search has native track identities and duplicate sources get distinct queue entry IDs", async () => {
    const h = harness(),
        signal = new AbortController().signal
    const a = (await h.resolver.search("hello", "9", signal))[0]
    const b = (await h.resolver.search("hello", "9", signal))[0]
    assert.equal(a.sourceId, "dQw4w9WgXcQ")
    assert.notEqual(a.entryId, b.entryId)
    assert.equal("encoded" in a, false)
    assert.deepEqual(h.identifiers, ["ytsearch:hello", "ytsearch:hello"])
    assert.deepEqual(h.prepared, [])
})

test("catalog metadata is preserved but preparation finds and streams a YouTube companion source", async () => {
    const h = harness(),
        signal = new AbortController().signal
    h.setCatalog()
    const track = (await h.resolver.search(catalog.info.uri, "9", signal))[0]
    assert.equal(track.title, "Catalog title")
    assert.equal(track.source, "spotify")
    h.setYoutube()
    const source = await h.resolver.prepare(track, signal)
    assert.deepEqual(h.prepared, ["dQw4w9WgXcQ"])
    assert.equal(source.durationMs, 150000)
    assert.equal(source.playbackUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    assert.equal(track.uri, catalog.info.uri)
    assert.equal(h.identifiers.at(-1), "ytsearch:Catalog artist - Catalog title audio")
})

test("prepares a fresh source on every attempt instead of persisting expiring stream URLs", async () => {
    const h = harness(),
        signal = new AbortController().signal
    const track = (await h.resolver.search("hello", "9", signal))[0]
    const a = await h.resolver.prepare(track, signal),
        b = await h.resolver.prepare(track, signal)
    const bytes = async (source: typeof a) => {
        for await (const value of source.input) return [...value]
    }
    assert.deepEqual(await bytes(a), [1])
    assert.deepEqual(await bytes(b), [2])
})

test("rejects filesystem queries and private URLs without sending them to metadata search", async () => {
    const h = harness(),
        signal = new AbortController().signal
    for (const query of [
        "file:///etc/passwd",
        "local:/downloads/secret.wav",
        "ftp://host/file",
        "http://127.0.0.1/file",
        "http://invidious-companion:8282/companion/secret",
    ]) {
        await assert.rejects(h.resolver.search(query, "9", signal))
    }
    assert.deepEqual(h.identifiers, [])
})

test("malformed metadata and load errors fail with safe messages", async () => {
    for (const payload of [
        { loadType: "error", data: { message: "secret" } },
        { loadType: "search", data: [{ info: {} }] },
    ]) {
        const metadata = new LavalinkSearch({
            origin: "http://lavalink:2333",
            password: "secret",
            fetchImpl: async () => Response.json(payload),
        })
        await assert.rejects(
            metadata.load("ytsearch:hello", "9", new AbortController().signal),
            (error: Error) => !error.message.includes("secret")
        )
    }
})
