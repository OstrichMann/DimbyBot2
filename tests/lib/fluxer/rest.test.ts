import assert from "node:assert/strict"
import { test } from "node:test"
import { FluxerRest, FluxerRestError } from "../../../src/lib/fluxer/rest.js"

function harness(fetchImpl: typeof fetch) {
    let now = 0
    const waits: number[] = []
    const rest = new FluxerRest("https://api.example/api/v1", "private-token", {
        fetchImpl,
        now: () => now,
        sleep: async (ms, signal) => {
            signal?.throwIfAborted()
            waits.push(ms)
            now += ms
        },
    })
    return { rest, waits }
}

test("uses bot auth and the discovered API without leaking credentials to a different URL", async () => {
    let calls = 0
    const { rest } = harness(async (input, init) => {
        calls++
        assert.equal(String(input), "https://api.example/api/v1/channels/123/messages")
        assert.equal(new Headers(init?.headers).get("authorization"), "Bot private-token")
        assert.equal(init?.redirect, "error")
        assert.equal(init?.body, '{"content":"hello"}')
        return Response.json({ id: "456" })
    })
    assert.deepEqual(
        await rest.request("POST", "/channels/123/messages", { body: { content: "hello" } }),
        { id: "456" }
    )
    for (const path of [
        "https://evil.example",
        "//evil.example",
        "/../outside",
        "/%2e%2e/outside",
        "/channels?token=x",
        "/channels#fragment",
        "/channels\\outside",
    ]) {
        await assert.rejects(rest.request("GET", path))
    }
    assert.equal(calls, 1)
})

test("honors decimal retry_after and stops after three rate-limited attempts", async () => {
    let calls = 0
    const { rest, waits } = harness(async () => {
        calls++
        return Response.json(
            { retry_after: 0.25, global: true },
            { status: 429, headers: { "Retry-After": "1" } }
        )
    })
    await assert.rejects(
        rest.request("POST", "/channels/123/messages"),
        (e) => e instanceof FluxerRestError && e.status === 429
    )
    assert.equal(calls, 3)
    assert.deepEqual(waits, [250, 250])
})

test("successful bucket exhaustion delays later requests sharing that bucket", async () => {
    let calls = 0
    const { rest, waits } = harness(async () => {
        calls++
        return Response.json(
            { ok: true },
            {
                headers: {
                    "X-RateLimit-Bucket": "shared",
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset-After": "0.4",
                },
            }
        )
    })
    await rest.request("GET", "/guilds/123")
    await rest.request("GET", "/guilds/123")
    assert.equal(calls, 2)
    assert.deepEqual(waits, [400])
})

test("does not retry ambiguous message sends or expose upstream error details", async () => {
    let calls = 0
    const { rest } = harness(async () => {
        calls++
        throw new Error("private-token https://internal.example")
    })
    await assert.rejects(rest.request("POST", "/channels/123/messages"), (e: Error) => {
        assert.equal(e.message.includes("private-token"), false)
        assert.equal(e.message.includes("internal.example"), false)
        return true
    })
    assert.equal(calls, 1)
})

test("auth failure is not retried or reflected and 204 has no JSON body", async () => {
    const { rest } = harness(async () => new Response("private-token", { status: 401 }))
    await assert.rejects(
        rest.request("GET", "/users/@me"),
        (e) =>
            e instanceof FluxerRestError && e.status === 401 && !e.message.includes("private-token")
    )
    const empty = harness(async () => new Response(null, { status: 204 }))
    assert.equal(await empty.rest.request("DELETE", "/channels/123/messages/456"), undefined)
})

test("aborted callers cannot send requests or retry after rate limiting", async () => {
    const controller = new AbortController()
    let calls = 0
    const { rest } = harness(async () => {
        calls++
        controller.abort()
        return Response.json({ retry_after: 1, global: true }, { status: 429 })
    })
    await assert.rejects(rest.request("GET", "/users/@me", { signal: controller.signal }), {
        name: "AbortError",
    })
    assert.equal(calls, 1)
    await assert.rejects(rest.request("GET", "/users/@me", { signal: controller.signal }), {
        name: "AbortError",
    })
    assert.equal(calls, 1)
})

function gatedSleep() {
    const sleeps: { ms: number; release: () => void }[] = []
    let now = 0
    return {
        sleeps,
        now: () => now,
        sleep: (ms: number, signal?: AbortSignal) =>
            new Promise<void>((resolve, reject) => {
                signal?.throwIfAborted()
                // Short global spacing passes through; only real cooldowns are held.
                if (ms < 1000) {
                    now += ms
                    return resolve()
                }
                signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
                sleeps.push({
                    ms,
                    release: () => {
                        now += ms
                        resolve()
                    },
                })
            }),
    }
}

test("a rate-limited route does not hold up requests to unrelated routes", async () => {
    const clock = gatedSleep()
    let limited = true
    const rest = new FluxerRest("https://api.example/api/v1", "private-token", {
        now: clock.now,
        sleep: clock.sleep,
        fetchImpl: async (input) => {
            if (String(input).endsWith("/messages") && limited) {
                limited = false
                return Response.json({ retry_after: 5 }, { status: 429 })
            }
            return Response.json({ ok: true })
        },
    })
    const slow = rest.request("POST", "/channels/1/messages", { body: {} })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(clock.sleeps.length, 1)
    assert.deepEqual(await rest.request("GET", "/guilds/2"), { ok: true })
    clock.sleeps[0].release()
    assert.deepEqual(await slow, { ok: true })
})

test("a retry wait beyond the request budget fails fast instead of stalling the bucket", async () => {
    const clock = gatedSleep()
    let calls = 0
    const rest = new FluxerRest("https://api.example/api/v1", "private-token", {
        now: clock.now,
        sleep: clock.sleep,
        fetchImpl: async () => {
            calls++
            return Response.json({ retry_after: 60 }, { status: 429 })
        },
    })
    await assert.rejects(
        rest.request("GET", "/guilds/1"),
        (e) => e instanceof FluxerRestError && e.status === 429
    )
    assert.equal(calls, 1)
    assert.equal(clock.sleeps.length, 0)
})

test("a queued caller whose signal aborts is rejected without waiting for the head request", async () => {
    const clock = gatedSleep()
    let calls = 0
    const rest = new FluxerRest("https://api.example/api/v1", "private-token", {
        now: clock.now,
        sleep: clock.sleep,
        fetchImpl: async () => {
            calls++
            return calls === 1
                ? Response.json({ retry_after: 5 }, { status: 429 })
                : Response.json({ ok: true })
        },
    })
    const head = rest.request("GET", "/guilds/1")
    await new Promise((resolve) => setImmediate(resolve))
    const controller = new AbortController()
    const queued = rest.request("GET", "/guilds/1", { signal: controller.signal })
    controller.abort()
    await assert.rejects(queued, { name: "AbortError" })
    clock.sleeps[0].release()
    assert.deepEqual(await head, { ok: true })
    assert.equal(calls, 2)
})
