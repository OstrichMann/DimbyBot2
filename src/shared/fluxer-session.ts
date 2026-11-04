import { auth } from "./auth-node.js"
import { getWebPrismaClient } from "../lib/webPrisma.js"
import { isFluxerId } from "./fluxer-user-id.js"

export interface AuthenticatedActor {
    userId: string
    authUserId: string
    sessionId: string
    expiresAt: number
}
export class FluxerSessionError extends Error {
    constructor(
        readonly status: 401 | 403 | 503,
        message: string
    ) {
        super(message)
        this.name = "FluxerSessionError"
    }
}
interface SessionDependencies {
    getSession(
        headers: Headers
    ): Promise<{ user: { id: string }; session: { id: string; expiresAt: string | Date } } | null>
    accounts(userId: string): Promise<{ providerId: string; accountId: string }[]>
}
const defaults: SessionDependencies = {
    getSession: (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
    accounts: (userId) =>
        getWebPrismaClient().account.findMany({
            where: { userId, providerId: "fluxer" },
            select: { providerId: true, accountId: true },
        }),
}

/** Session UUIDs and browser actor claims are never substituted for a native provider identity. */
export async function requireFluxerActor(
    headers: Headers,
    dependencies: SessionDependencies = defaults
): Promise<AuthenticatedActor> {
    try {
        const session = await dependencies.getSession(headers)
        const expiresAt = session ? new Date(session.session.expiresAt).getTime() : NaN
        if (
            !session?.user?.id ||
            !session.session?.id ||
            !Number.isFinite(expiresAt) ||
            expiresAt <= Date.now()
        )
            throw new FluxerSessionError(401, "Sign in with Fluxer")
        const accounts = (await dependencies.accounts(session.user.id)).filter(
            (row) => row.providerId === "fluxer"
        )
        if (accounts.length !== 1 || !isFluxerId(accounts[0].accountId))
            throw new FluxerSessionError(403, "A Fluxer account is required")
        return {
            userId: accounts[0].accountId,
            authUserId: session.user.id,
            sessionId: session.session.id,
            expiresAt,
        }
    } catch (error) {
        if (error instanceof FluxerSessionError) throw error
        throw new FluxerSessionError(503, "Session verification unavailable")
    }
}
