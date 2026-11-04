import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto"
import { getWebPrismaClient } from "../lib/webPrisma.js"
import { exchangeFluxerToken, type FluxerOAuthConfig } from "./fluxer-oauth.js"

/** PostgreSQL locks coordinate refresh rotation across both application processes. */
export class FluxerOAuthAccounts {
    constructor(
        private readonly config: FluxerOAuthConfig,
        private readonly secret: string,
        private readonly fetchImpl: typeof fetch = fetch
    ) {}
    async accessToken(authUserId: string): Promise<string> {
        try {
            return await getWebPrismaClient().$transaction(
                async (tx) => {
                    const provider = "fluxer"
                    const locked = await tx.$queryRaw<
                        { id: string }[]
                    >`SELECT id FROM account WHERE "userId" = ${authUserId} AND "providerId" = ${provider} ORDER BY id FOR UPDATE`
                    if (locked.length !== 1) throw new Error("Fluxer account required")
                    // Read after acquiring the lock: a competing process may have just rotated this pair.
                    const account = await tx.account.findUnique({ where: { id: locked[0].id } })
                    if (
                        !account ||
                        account.providerId !== "fluxer" ||
                        account.userId !== authUserId
                    )
                        throw new Error("Fluxer account required")
                    if (
                        account.accessToken &&
                        account.accessTokenExpiresAt &&
                        account.accessTokenExpiresAt.getTime() > Date.now() + 60_000
                    )
                        return await symmetricDecrypt({
                            key: this.secret,
                            data: account.accessToken,
                        })
                    if (
                        !account.refreshToken ||
                        (account.refreshTokenExpiresAt &&
                            account.refreshTokenExpiresAt.getTime() <= Date.now())
                    )
                        throw new Error("Sign in again")
                    const previous = await symmetricDecrypt({
                        key: this.secret,
                        data: account.refreshToken,
                    })
                    const tokens = await exchangeFluxerToken(
                        this.config,
                        { grant_type: "refresh_token", refresh_token: previous },
                        this.fetchImpl
                    )
                    await tx.account.update({
                        where: { id: account.id },
                        data: {
                            accessToken: await symmetricEncrypt({
                                key: this.secret,
                                data: tokens.accessToken,
                            }),
                            refreshToken: await symmetricEncrypt({
                                key: this.secret,
                                data: tokens.refreshToken ?? previous,
                            }),
                            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
                            ...(tokens.scopes ? { scope: tokens.scopes.join(" ") } : {}),
                        },
                    })
                    return tokens.accessToken
                },
                { maxWait: 5000, timeout: 15000 }
            )
        } catch {
            throw new Error("Fluxer authorization unavailable; sign in again")
        }
    }
}
