import assert from "node:assert/strict"
import { test, mock } from "node:test"
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto"

const secret = "separate-test-secret-over-thirty-two-characters"
const account = {
    id: "account",
    userId: "uuid",
    providerId: "fluxer",
    accountId: "9",
    accessToken: await symmetricEncrypt({ key: secret, data: "old-access" }),
    refreshToken: await symmetricEncrypt({ key: secret, data: "old-refresh" }),
    accessTokenExpiresAt: new Date(0),
    refreshTokenExpiresAt: new Date(Date.now() + 3600000),
    scope: "identify email guilds",
}
let tail = Promise.resolve(),
    queries = 0
const prisma = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        let release: () => void
        const previous = tail
        tail = new Promise<void>((resolve) => {
            release = resolve
        })
        try {
            return await work({
                $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
                    assert.match(sql.join("?"), /FOR UPDATE/)
                    assert.deepEqual(values, ["uuid", "fluxer"])
                    queries++
                    await previous
                    return [{ id: "account" }]
                },
                account: {
                    findUnique: async () => ({ ...account }),
                    update: async ({ data }: { data: unknown }) => Object.assign(account, data),
                },
            })
        } finally {
            release!()
        }
    },
}
mock.module("../../src/lib/webPrisma.js", { namedExports: { getWebPrismaClient: () => prisma } })
const { FluxerOAuthAccounts } = await import("../../src/shared/fluxer-oauth-accounts.js")

test("independent auth consumers lock the same database account and share one encrypted rotated pair", async () => {
    let exchanges = 0
    const config = {
        instanceOrigin: "https://instance.example",
        api: "https://api.example/v1",
        webapp: "https://chat.example",
        cdn: "https://cdn.example",
        media: "https://media.example",
        clientId: "1",
        clientSecret: "secret",
        dashboardOrigin: "http://localhost:3000",
    }
    const fetchImpl: typeof fetch = async (_input, options) => {
        exchanges++
        assert.equal((options.body as URLSearchParams).get("refresh_token"), "old-refresh")
        await new Promise((resolve) => setImmediate(resolve))
        return Response.json({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
        })
    }
    const first = new FluxerOAuthAccounts(config, secret, fetchImpl),
        second = new FluxerOAuthAccounts(config, secret, fetchImpl)
    assert.deepEqual(await Promise.all([first.accessToken("uuid"), second.accessToken("uuid")]), [
        "new-access",
        "new-access",
    ])
    assert.equal(exchanges, 1)
    assert.equal(queries, 2)
    assert.notEqual(account.refreshToken, "new-refresh")
    assert.equal(await symmetricDecrypt({ key: secret, data: account.refreshToken }), "new-refresh")
    account.accessTokenExpiresAt = new Date(0)
    await assert.rejects(
        new FluxerOAuthAccounts(
            config,
            secret,
            async () => new Response("secret", { status: 401 })
        ).accessToken("uuid"),
        (e: Error) => !e.message.includes("secret")
    )
})

test("a revoked or expired refresh grant asks the user to sign in again; an outage does not", async () => {
    const { FluxerReauthRequiredError } = await import("../../src/shared/fluxer-oauth.js")
    const config = {
        instanceOrigin: "https://instance.example",
        api: "https://api.example/v1",
        webapp: "https://chat.example",
        cdn: "https://cdn.example",
        media: "https://media.example",
        clientId: "1",
        clientSecret: "secret",
        dashboardOrigin: "http://localhost:3000",
    }
    const withStatus = (status: number) =>
        new FluxerOAuthAccounts(config, secret, async () =>
            Response.json({ error: "invalid_grant" }, { status })
        ).accessToken("uuid")
    account.accessTokenExpiresAt = new Date(0)
    for (const status of [400, 401])
        await assert.rejects(
            withStatus(status),
            (e) => e instanceof FluxerReauthRequiredError && e.status === 401
        )
    await assert.rejects(withStatus(503), (e) => !(e instanceof FluxerReauthRequiredError))
    const refreshToken = account.refreshToken
    account.refreshToken = null as unknown as string
    await assert.rejects(withStatus(200), (e) => e instanceof FluxerReauthRequiredError)
    account.refreshToken = refreshToken
})
