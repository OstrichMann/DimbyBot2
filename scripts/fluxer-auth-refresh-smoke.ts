import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto"
import { getWebPrismaClient } from "../src/lib/webPrisma.js"

/** Synthetic credentials only; refuses to seed or delete rows in any other database. */
const database = new URL(process.env.DATABASE_URL ?? "")
assert.equal(
    database.pathname,
    "/dimbybot_fluxer_local",
    "Use the isolated Fluxer local test database"
)
const secret = process.env.BETTER_AUTH_SECRET!
assert.ok(secret?.length >= 32)
const prisma = getWebPrismaClient(),
    userId = `fluxer-auth-smoke-${randomUUID()}`,
    accountId = randomUUID()
let exchanges = 0
const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    const form = new URLSearchParams(body)
    if (
        request.url !== "/v1/oauth2/token" ||
        form.get("refresh_token") !== "synthetic-old-refresh"
    ) {
        response.writeHead(400).end()
        return
    }
    exchanges++
    await new Promise((resolve) => setTimeout(resolve, 100))
    response.setHeader("content-type", "application/json")
    response.end(
        JSON.stringify({
            access_token: "synthetic-new-access",
            refresh_token: "synthetic-new-refresh",
            expires_in: 3600,
        })
    )
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert.ok(address && typeof address !== "string")
const api = `http://127.0.0.1:${address.port}/v1`
try {
    await prisma.user.create({
        data: {
            id: userId,
            name: "Synthetic refresh test",
            email: `${randomUUID()}@refresh-test.invalid`,
            accounts: {
                create: {
                    id: accountId,
                    providerId: "fluxer",
                    accountId: "9",
                    accessToken: await symmetricEncrypt({
                        key: secret,
                        data: "synthetic-old-access",
                    }),
                    refreshToken: await symmetricEncrypt({
                        key: secret,
                        data: "synthetic-old-refresh",
                    }),
                    accessTokenExpiresAt: new Date(0),
                },
            },
        },
    })
    const childCode = `
        import { FluxerOAuthAccounts } from './src/shared/fluxer-oauth-accounts.ts'
        import { getWebPrismaClient } from './src/lib/webPrisma.ts'
        try {
            const accounts = new FluxerOAuthAccounts(JSON.parse(process.env.FLUXER_AUTH_SMOKE_CONFIG), process.env.BETTER_AUTH_SECRET)
            const token = await accounts.accessToken(process.env.FLUXER_AUTH_SMOKE_USER)
            process.send({ ok: token === 'synthetic-new-access' })
        } catch { process.send({ ok: false }) }
        finally { await getWebPrismaClient().$disconnect(); process.disconnect() }
    `
    const config = {
        instanceOrigin: "https://synthetic.invalid",
        api,
        webapp: "https://synthetic.invalid",
        media: "https://synthetic.invalid/media",
        cdn: "https://synthetic.invalid",
        clientId: "1",
        clientSecret: "synthetic-client-secret",
        dashboardOrigin: "http://localhost:3000",
    }
    const consumer = () =>
        new Promise<boolean>((resolve, reject) => {
            const child = spawn(
                process.execPath,
                ["--import", "tsx", "--input-type=module", "-e", childCode],
                {
                    env: {
                        ...process.env,
                        FLUXER_AUTH_SMOKE_CONFIG: JSON.stringify(config),
                        FLUXER_AUTH_SMOKE_USER: userId,
                    },
                    stdio: ["ignore", "ignore", "ignore", "ipc"],
                }
            )
            let passed = false
            child.on("message", (message) => {
                passed =
                    !!message &&
                    typeof message === "object" &&
                    "ok" in message &&
                    message.ok === true
            })
            child.once("error", reject)
            child.once("exit", (code) => resolve(code === 0 && passed))
            const timer = setTimeout(() => {
                child.kill()
                reject(new Error("Refresh process timed out"))
            }, 25000)
            child.once("exit", () => clearTimeout(timer))
        })
    assert.deepEqual(await Promise.all([consumer(), consumer()]), [true, true])
    assert.equal(exchanges, 1)
    const row = await prisma.account.findUniqueOrThrow({ where: { id: accountId } })
    assert.notEqual(row.refreshToken, "synthetic-new-refresh")
    assert.equal(
        await symmetricDecrypt({ key: secret, data: row.refreshToken! }),
        "synthetic-new-refresh"
    )
    console.log(
        "PASS: two independent Node processes shared one PostgreSQL-locked refresh and encrypted rotated credentials."
    )
} finally {
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
    )
}
