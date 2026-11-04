import { createHash } from "node:crypto"
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { isFluxerId } from "./fluxer-user-id.js"

export interface FluxerOAuthConfig {
    instanceOrigin: string
    api: string
    webapp: string
    cdn: string
    media: string
    clientId: string
    clientSecret: string
    dashboardOrigin: string
}
function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
}

/** Better Auth account IDs always come from the Fluxer provider, never an email or session UUID. */
export function fluxerProfile(value: unknown, config: FluxerOAuthConfig) {
    const data = record(value)
    if (!isFluxerId(data.id) || typeof data.username !== "string" || !data.username.trim())
        throw new Error("Invalid Fluxer profile")
    const email =
        typeof data.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)
            ? data.email
            : null
    const identity = createHash("sha256")
        .update(new URL(config.instanceOrigin).origin)
        .update("\0")
        .update(data.id)
        .digest("hex")
    return {
        id: data.id,
        name:
            typeof data.global_name === "string" && data.global_name.trim()
                ? data.global_name
                : data.username,
        email: email ?? `${identity}@accounts.fluxer.invalid`,
        emailVerified: !!email && data.verified === true,
        image:
            typeof data.avatar === "string" && /^[a-zA-Z0-9_]+$/.test(data.avatar)
                ? `${config.media}/avatars/${data.id}/${data.avatar}.webp`
                : null,
    }
}

/** One bounded token exchange with no credential-bearing provider response in errors or logs. */
export async function exchangeFluxerToken(
    config: FluxerOAuthConfig,
    grant: Record<string, string>,
    fetchImpl: typeof fetch = fetch
) {
    if (grant.grant_type === "authorization_code" && !grant.code_verifier)
        throw new Error("Fluxer PKCE verifier required")
    try {
        const response = await fetchImpl(`${config.api}/oauth2/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                ...grant,
                client_id: config.clientId,
                client_secret: config.clientSecret,
            }),
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Error("Token response failed")
        const data = record(await response.json())
        if (
            typeof data.access_token !== "string" ||
            !data.access_token ||
            typeof data.expires_in !== "number" ||
            !Number.isFinite(data.expires_in) ||
            data.expires_in <= 0 ||
            (data.token_type !== undefined && String(data.token_type).toLowerCase() !== "bearer")
        )
            throw new Error("Invalid token response")
        const accessTokenExpiresAt = new Date(Date.now() + data.expires_in * 1000)
        if (!Number.isFinite(accessTokenExpiresAt.getTime()))
            throw new Error("Invalid token expiry")
        return {
            accessToken: data.access_token,
            refreshToken:
                typeof data.refresh_token === "string" && data.refresh_token
                    ? data.refresh_token
                    : grant.refresh_token,
            accessTokenExpiresAt,
            scopes:
                typeof data.scope === "string"
                    ? data.scope.split(/\s+/).filter(Boolean)
                    : undefined,
            tokenType: "Bearer",
        }
    } catch {
        throw new Error("Fluxer OAuth token exchange failed")
    }
}

type FluxerProvider = Pick<
    GenericOAuthConfig,
    | "providerId"
    | "clientId"
    | "clientSecret"
    | "authorizationUrl"
    | "tokenUrl"
    | "scopes"
    | "pkce"
    | "getToken"
    | "getUserInfo"
>

export function fluxerOAuthProvider(
    config: FluxerOAuthConfig,
    fetchImpl: typeof fetch = fetch
): FluxerProvider {
    return {
        providerId: "fluxer",
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        authorizationUrl: `${config.webapp}/oauth2/authorize`,
        tokenUrl: `${config.api}/oauth2/token`,
        scopes: ["identify", "email", "guilds"],
        pkce: true,
        getToken: ({ code, redirectURI, codeVerifier }) =>
            exchangeFluxerToken(
                config,
                {
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: redirectURI,
                    code_verifier: codeVerifier ?? "",
                },
                fetchImpl
            ),
        getUserInfo: async (tokens) => {
            try {
                const response = await fetchImpl(`${config.api}/users/@me`, {
                    headers: { Authorization: `Bearer ${tokens.accessToken}` },
                    redirect: "error",
                    signal: AbortSignal.timeout(10_000),
                })
                if (!response.ok) throw new Error("Profile response failed")
                return fluxerProfile(await response.json(), config)
            } catch {
                throw new Error("Fluxer OAuth profile request failed")
            }
        },
    }
}

/** Disable unlocked token APIs; all consumers refresh through the shared PostgreSQL row lock. */
export function fluxerAuthPolicy(secret: string, dashboardOrigin: string) {
    const url = new URL(dashboardOrigin)
    if (
        !["http:", "https:"].includes(url.protocol) ||
        url.origin !== dashboardOrigin ||
        url.username ||
        url.password
    )
        throw new Error("BETTER_AUTH_URL must be the Dashboard origin")
    if (secret.length < 32)
        throw new Error("Use a separate BETTER_AUTH_SECRET of at least 32 characters")
    const secure = url.protocol === "https:"
    return {
        secret,
        baseURL: dashboardOrigin,
        trustedOrigins: [dashboardOrigin],
        hooks: {
            before: createAuthMiddleware(async (ctx) => {
                if (
                    ctx.request &&
                    !["GET", "HEAD", "OPTIONS"].includes(ctx.request.method) &&
                    ctx.request.headers.get("origin") !== dashboardOrigin
                )
                    throw new APIError("FORBIDDEN", { message: "Dashboard origin required" })
            }),
        },
        onAPIError: { errorURL: "/auth/error" },
        advanced: {
            cookiePrefix: "dimby-fluxer",
            useSecureCookies: secure,
            defaultCookieAttributes: { secure, httpOnly: true, sameSite: "lax" as const },
        },
        account: { encryptOAuthTokens: true, accountLinking: { enabled: false } },
        disabledPaths: ["/get-access-token", "/refresh-token", "/link-social", "/oauth2/link"],
        session: { cookieCache: { enabled: false } },
    }
}
