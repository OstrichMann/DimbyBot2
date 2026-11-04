import { betterAuth } from "better-auth"
import { genericOAuth } from "better-auth/plugins/generic-oauth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { nextCookies } from "better-auth/next-js"
import { getFluxerAuthConfig, lazyAsyncAuth } from "@/shared/fluxer-auth-config.js"
import { getWebPrismaClient } from "@/lib/prisma.js"

async function createAuthInstance() {
    const { provider, ...config } = await getFluxerAuthConfig()
    return betterAuth({
        ...config,
        database: prismaAdapter(getWebPrismaClient(), { provider: "postgresql" }),
        plugins: [genericOAuth({ config: [provider] }), nextCookies()],
    })
}

/** Next cookies remain Dashboard-only; discovery and credentials are initialized on the server. */
export const auth = lazyAsyncAuth(createAuthInstance)
export type BetterAuthSession = typeof auth.$Infer.Session
