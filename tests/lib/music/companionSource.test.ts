import assert from "node:assert/strict"
import { test } from "node:test"
import { CompanionSource } from "../../../src/lib/music/companionSource.js"

test("resolves companion metadata and confines every authenticated stream request to its origin", async () => {
    const paths: string[] = []
    const companion = new CompanionSource({
        origin: "http://companion:8282",
        secret: "secret",
        fetchImpl: async (input, init) => {
            const url = new URL(String(input))
            paths.push(url.pathname)
            assert.equal(url.origin, "http://companion:8282")
            assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret")
            if (url.pathname.endsWith("/player"))
                return Response.json({
                    videoDetails: { lengthSeconds: "150" },
                    streamingData: { adaptiveFormats: [{ itag: 251, mimeType: "audio/webm" }] },
                })
            if (url.pathname.endsWith("/latest_version"))
                return new Response(null, {
                    status: 302,
                    headers: { location: "/companion/videoplayback?token=ephemeral" },
                })
            return new Response(new Uint8Array([1, 2]))
        },
    })
    const source = await companion.prepare("dQw4w9WgXcQ", new AbortController().signal)
    assert.equal(source.durationMs, 150000)
    assert.equal(source.playbackUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    assert.deepEqual(paths, [
        "/companion/youtubei/v1/player",
        "/companion/latest_version",
        "/companion/videoplayback",
    ])
    await source.close()
})

test("refuses external redirects without forwarding companion credentials", async () => {
    let calls = 0
    const companion = new CompanionSource({
        origin: "http://companion:8282",
        secret: "secret",
        fetchImpl: async () => {
            calls++
            if (calls === 1)
                return Response.json({
                    streamingData: { adaptiveFormats: [{ itag: 251, mimeType: "audio/webm" }] },
                })
            return new Response(null, {
                status: 302,
                headers: { location: "http://127.0.0.1/secret" },
            })
        },
    })
    await assert.rejects(
        companion.prepare("dQw4w9WgXcQ", new AbortController().signal),
        (e: Error) => !e.message.includes("secret")
    )
    assert.equal(calls, 2)
})

test("rewrites googlevideo redirects through the configured companion proxy", async () => {
    let calls = 0
    const companion = new CompanionSource({
        origin: "http://companion:8282",
        secret: "secret",
        fetchImpl: async (input) => {
            const url = new URL(String(input))
            calls++
            if (calls === 1)
                return Response.json({ streamingData: { adaptiveFormats: [{ itag: 251 }] } })
            if (calls === 2)
                return new Response(null, {
                    status: 302,
                    headers: { location: "https://rr1.googlevideo.com/videoplayback?id=abc" },
                })
            assert.equal(url.origin, "http://companion:8282")
            assert.equal(url.pathname, "/companion/videoplayback")
            assert.equal(url.searchParams.get("host"), "rr1.googlevideo.com")
            return new Response(new Uint8Array([1]))
        },
    })
    const source = await companion.prepare("dQw4w9WgXcQ", new AbortController().signal)
    assert.equal(calls, 3)
    assert.equal(source.seekable, false)
    await source.close()
})
