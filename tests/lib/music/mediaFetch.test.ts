import assert from "node:assert/strict"
import { test } from "node:test"
import { PublicMediaFetcher } from "../../../src/lib/music/mediaFetch.js"

test("pins the validated public DNS address into the media connection", async () => {
    let lookups = 0
    const fetcher = new PublicMediaFetcher({
        lookup: async () => {
            lookups++
            return [{ address: lookups === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }]
        },
        request: async (url, address) => {
            assert.equal(url.hostname, "audio.example")
            assert.equal(address.address, "8.8.8.8")
            return {
                status: 200,
                headers: new Headers(),
                body: (async function* () {
                    yield new Uint8Array([1])
                })(),
                close() {},
            }
        },
    })
    const response = await fetcher.open(
        "https://audio.example/song.mp3",
        new AbortController().signal
    )
    const received = []
    for await (const bytes of response.body) received.push(...bytes)
    assert.deepEqual(received, [1])
    assert.equal(lookups, 1)
})

test("private DNS answers and redirects never reach a private media endpoint", async () => {
    let requests = 0
    const fetcher = new PublicMediaFetcher({
        lookup: async (host) => [
            { address: host === "private.example" ? "10.0.0.1" : "8.8.8.8", family: 4 },
        ],
        request: async () => {
            requests++
            return {
                status: 302,
                headers: new Headers({ location: "http://private.example/secret" }),
                body: (async function* () {})(),
                close() {},
            }
        },
    })
    await assert.rejects(
        fetcher.open("https://audio.example/song.mp3", new AbortController().signal),
        /allowed/i
    )
    assert.equal(requests, 1)
    for (const address of [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "::1",
        "fc00::1",
        "::ffff:127.0.0.1",
    ]) {
        const privateFetcher = new PublicMediaFetcher({
            lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
            request: async () => {
                throw new Error("must not connect")
            },
        })
        await assert.rejects(
            privateFetcher.open("https://audio.example/song.mp3", new AbortController().signal),
            /allowed/i
        )
    }
})

test("rejects credentialed/non-HTTP inputs, mixed private DNS and redirect loops", async () => {
    const fetcher = new PublicMediaFetcher({
        lookup: async () => [
            { address: "8.8.8.8", family: 4 },
            { address: "10.0.0.1", family: 4 },
        ],
        request: async () => {
            throw new Error("must not connect")
        },
    })
    for (const url of [
        "https://audio.example/song.mp3",
        "https://user:pass@audio.example",
        "file:///etc/passwd",
    ])
        await assert.rejects(fetcher.open(url, new AbortController().signal), /allowed/i)
    let calls = 0
    const loop = new PublicMediaFetcher({
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        request: async () => {
            calls++
            return {
                status: 302,
                headers: new Headers({ location: "/again" }),
                body: (async function* () {})(),
                close() {},
            }
        },
    })
    await assert.rejects(
        loop.open("https://audio.example/song.mp3", new AbortController().signal),
        /redirect/i
    )
    assert.equal(calls, 6)
})

test("cancellation does not wait for DNS resolution to finish", { timeout: 1000 }, async () => {
    const controller = new AbortController()
    const fetcher = new PublicMediaFetcher({ lookup: () => new Promise(() => {}) })
    const opened = fetcher.open("https://audio.example/song.mp3", controller.signal)
    controller.abort()
    await assert.rejects(opened, { name: "AbortError" })
})
