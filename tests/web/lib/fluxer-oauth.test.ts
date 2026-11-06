import assert from "node:assert/strict"
import { test } from "node:test"
import { betterAuth } from "better-auth"
import { genericOAuth } from "better-auth/plugins/generic-oauth"
import { fluxerAuthPolicy, fluxerOAuthProvider } from "../../../src/shared/fluxer-oauth.js"
import { lazyAsyncAuth } from "../../../src/shared/fluxer-auth-config.js"

test("Dashboard generic OAuth uses its own package instance with the shared Fluxer policy", async () => {
    const provider = fluxerOAuthProvider({
        instanceOrigin: "https://instance.example",
        api: "https://api.example/v1",
        webapp: "https://chat.example",
        cdn: "https://static.example",
        media: "https://media.example",
        clientId: "1",
        clientSecret: "test-secret",
        dashboardOrigin: "http://localhost:3000",
    })
    const auth = betterAuth({
        ...fluxerAuthPolicy("a-separate-secret-at-least-32-characters", "http://localhost:3000"),
        plugins: [genericOAuth({ config: [provider] })],
        logger: { disabled: true },
    })
    const response = await auth.handler(
        new Request("http://localhost:3000/api/auth/sign-in/oauth2", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "http://localhost:3000" },
            body: JSON.stringify({ providerId: "fluxer", callbackURL: "/" }),
        })
    )
    assert.equal(response.status, 200)
    const data = (await response.json()) as { url: string }
    assert.match(data.url, /^https:\/\/chat.example\/oauth2\/authorize\?/)
    assert.equal(auth.options.advanced?.cookiePrefix, "dimby-fluxer")
})

test("asynchronous auth initialization retries discovery failures and forwards handler and API receivers", async () => {
    let attempts = 0
    const actual = {
        value: "ready",
        api: {
            value: "api-ready",
            async getSession() {
                return this.value
            },
        },
        async handler() {
            return this.value
        },
    }
    const auth = lazyAsyncAuth(async () => {
        if (++attempts === 1) throw new Error("discovery unavailable")
        return actual
    })
    await assert.rejects(auth.handler(), /discovery unavailable/)
    assert.equal(await auth.handler(), "ready")
    assert.equal(await auth.api.getSession(), "api-ready")
    assert.equal(attempts, 2)
    assert.equal("handler" in auth, true)
})
