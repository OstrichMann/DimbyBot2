import assert from "node:assert/strict"
import { test } from "node:test"
import { betterAuth } from "better-auth"
import { genericOAuth } from "better-auth/plugins/generic-oauth"
import {
    fluxerOAuthProvider,
    fluxerProfile,
    exchangeFluxerToken,
    fluxerAuthPolicy,
} from "../../src/shared/fluxer-oauth.js"

const config = {
    instanceOrigin: "https://instance.example",
    api: "https://api.example/v1",
    webapp: "https://chat.example",
    cdn: "https://cdn.example",
    media: "https://media.example",
    clientId: "1",
    clientSecret: "private-secret",
    dashboardOrigin: "http://localhost:3000",
}

test("native OAuth requests identify/email/guilds with state and S256 PKCE and rejects wrong provider/callback state", async () => {
    let calls = 0
    const provider = fluxerOAuthProvider(config, async () => {
        calls++
        throw new Error("must not exchange invalid callback")
    })
    assert.deepEqual(provider.scopes, ["identify", "email", "guilds"])
    assert.equal(provider.pkce, true)
    const auth = betterAuth({
        ...fluxerAuthPolicy("a-separate-secret-at-least-32-characters", config.dashboardOrigin),
        plugins: [genericOAuth({ config: [provider] })],
        logger: { disabled: true },
    })
    const response = await auth.handler(
        new Request("http://localhost:3000/api/auth/sign-in/oauth2", {
            method: "POST",
            headers: { "content-type": "application/json", origin: config.dashboardOrigin },
            body: JSON.stringify({ providerId: "fluxer", callbackURL: "/" }),
        })
    )
    assert.equal(response.status, 200)
    const url = new URL(((await response.json()) as { url: string }).url)
    assert.equal(url.origin, config.webapp)
    assert.ok(url.searchParams.get("state"))
    assert.ok(url.searchParams.get("code_challenge"))
    assert.equal(url.searchParams.get("code_challenge_method"), "S256")
    assert.equal(
        url.searchParams.get("redirect_uri"),
        "http://localhost:3000/api/auth/oauth2/callback/fluxer"
    )
    const bad = await auth.handler(
        new Request("http://localhost:3000/api/auth/oauth2/callback/fluxer?code=fake&state=wrong")
    )
    assert.ok(bad.status >= 300)
    assert.equal(calls, 0)
    const wrong = await auth.handler(
        new Request("http://localhost:3000/api/auth/sign-in/oauth2", {
            method: "POST",
            headers: { "content-type": "application/json", origin: config.dashboardOrigin },
            body: JSON.stringify({ providerId: "discord" }),
        })
    )
    assert.equal(wrong.status, 400)
    const unsafe = await auth.handler(
        new Request("http://localhost:3000/api/auth/sign-in/oauth2", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://attacker.example" },
            body: JSON.stringify({ providerId: "fluxer" }),
        })
    )
    assert.equal(unsafe.status, 403)
    assert.equal(auth.options.account?.encryptOAuthTokens, true)
    assert.equal(auth.options.account?.accountLinking?.enabled, false)
    for (const path of ["get-access-token", "refresh-token"]) {
        const denied = await auth.handler(
            new Request(`http://localhost:3000/api/auth/${path}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
            })
        )
        assert.equal(denied.status, 404)
    }
})

test("profile identity is a native ID; missing email uses distinct instance-scoped reserved addresses", () => {
    const first = fluxerProfile({ id: "9", username: "User", avatar: "abc" }, config)
    assert.equal(first.id, "9")
    assert.equal(first.image, "https://media.example/avatars/9/abc.webp")
    assert.match(first.email, /@.*\.invalid$/)
    assert.equal(first.emailVerified, false)
    assert.notEqual(
        first.email,
        fluxerProfile(
            { id: "9", username: "User" },
            { ...config, instanceOrigin: "https://another.example" }
        ).email
    )
    const supplied = fluxerProfile(
        { id: "9", username: "User", email: "user@example.com", verified: true },
        config
    )
    assert.equal(supplied.emailVerified, true)
    assert.throws(() => fluxerProfile({ id: "uuid", username: "User" }, config), /profile/)
})

test("token exchanges preserve rotated refresh credentials, require PKCE and sanitize provider errors", async () => {
    let sent: URLSearchParams
    const fetchImpl: typeof fetch = async (_input, options) => {
        sent = options?.body as URLSearchParams
        return Response.json({
            access_token: "new-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
            scope: "identify email guilds",
            token_type: "Bearer",
        })
    }
    const tokens = await exchangeFluxerToken(
        config,
        {
            grant_type: "authorization_code",
            code: "code",
            redirect_uri: "http://localhost:3000/api/auth/oauth2/callback/fluxer",
            code_verifier: "verifier",
        },
        fetchImpl
    )
    assert.equal(tokens.refreshToken, "rotated-refresh")
    assert.equal(sent!.get("code_verifier"), "verifier")
    await assert.rejects(
        exchangeFluxerToken(config, { grant_type: "authorization_code", code: "code" }, fetchImpl),
        /PKCE/
    )
    await assert.rejects(
        exchangeFluxerToken(
            config,
            { grant_type: "refresh_token", refresh_token: "old" },
            async () => new Response("private-secret new-access", { status: 400 })
        ),
        (e: Error) => !e.message.includes("private-secret") && !e.message.includes("new-access")
    )
})
