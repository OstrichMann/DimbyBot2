import assert from "node:assert/strict"
import { test } from "node:test"
import { discoverFluxer } from "../../../src/lib/fluxer/discovery.js"

const endpoints = {
    api: "https://client.example/api",
    api_public: "https://public.example/api",
    gateway: "wss://gateway.example/?keep=1",
    static_cdn: "https://static.example",
    media: "https://media.example",
    webapp: "https://chat.example",
}

test("discovers native public API and asset endpoints without authentication", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
        assert.equal(String(input), "https://instance.example/.well-known/fluxer")
        assert.equal(new Headers(init?.headers).has("authorization"), false)
        return Response.json({ endpoints })
    }
    assert.deepEqual(await discoverFluxer("https://instance.example", fetchImpl), {
        api: "https://public.example/api/v1",
        gateway: "wss://gateway.example/?keep=1",
        cdn: "https://static.example",
        media: "https://media.example",
        webapp: "https://chat.example",
    })
})

test("normalizes version once and rejects missing or unsafe endpoints", async () => {
    const fixture = async (value: unknown) =>
        discoverFluxer("https://instance.example", async () => Response.json(value))
    assert.equal(
        (await fixture({ endpoints: { ...endpoints, api_public: "https://api.example/v1/" } })).api,
        "https://api.example/v1"
    )
    for (const value of [
        null,
        {},
        { endpoints: {} },
        { endpoints: { ...endpoints, api_public: "file:///secret" } },
        { endpoints: { ...endpoints, gateway: "https://wrong.example" } },
    ]) {
        await assert.rejects(fixture(value), /discovery/i)
    }
})

test("discovery rejects redirects and reports sanitized HTTP failures", async () => {
    await assert.rejects(
        discoverFluxer("https://instance.example", async (_input, init) => {
            assert.equal(init?.redirect, "error")
            return new Response("sensitive body", { status: 503 })
        }),
        /discovery.*503/i
    )
})
