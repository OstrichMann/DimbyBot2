import { betterAuth } from "better-auth"
import { genericOAuth } from "better-auth/plugins/generic-oauth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { getFluxerAuthConfig, lazyAsyncAuth } from "./fluxer-auth-config.js"
import { getWebPrismaClient } from "../lib/webPrisma.js"

async function createAuthInstance() {
    const { provider, ...config } = await getFluxerAuthConfig()
    return betterAuth({
        ...config,
        plugins: [genericOAuth({ config: [provider] })],
        database: prismaAdapter(getWebPrismaClient(), { provider: "postgresql" }),
    })
}

/** Bot-side session validation shares the independent Fluxer database and secret with the Dashboard. */
export const auth = lazyAsyncAuth(createAuthInstance)
export type BetterAuthSession = typeof auth.$Infer.Session
