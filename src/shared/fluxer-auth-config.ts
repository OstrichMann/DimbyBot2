import { discoverFluxer } from "../lib/fluxer/discovery.js"
import { isFluxerId } from "./fluxer-user-id.js"
import { fluxerAuthPolicy, fluxerOAuthProvider, type FluxerOAuthConfig } from "./fluxer-oauth.js"

let configuration: Promise<FluxerOAuthConfig> | undefined
/** Discovery and secrets are server-only and loaded on first auth request, never during Next build. */
export function getFluxerOAuthConfig(): Promise<FluxerOAuthConfig> {
    if (!configuration)
        configuration = (async () => {
            const instance = new URL(
                process.env.FLUXER_INSTANCE_ORIGIN?.trim() || "https://fluxer.com"
            )
            if (
                !["http:", "https:"].includes(instance.protocol) ||
                instance.username ||
                instance.password ||
                instance.pathname !== "/" ||
                instance.search ||
                instance.hash
            )
                throw new Error("Invalid FLUXER_INSTANCE_ORIGIN")
            const clientId = process.env.FLUXER_CLIENT_ID?.trim(),
                clientSecret = process.env.FLUXER_CLIENT_SECRET?.trim(),
                dashboardOrigin = process.env.BETTER_AUTH_URL?.trim()
            if (!isFluxerId(clientId) || !clientSecret || !dashboardOrigin)
                throw new Error(
                    "Configure FLUXER_CLIENT_ID, FLUXER_CLIENT_SECRET and BETTER_AUTH_URL"
                )
            const endpoints = await discoverFluxer(instance.origin)
            return {
                instanceOrigin: instance.origin,
                api: endpoints.api,
                webapp: endpoints.webapp,
                cdn: endpoints.cdn,
                media: endpoints.media,
                clientId,
                clientSecret,
                dashboardOrigin,
            }
        })().catch((error) => {
            configuration = undefined
            throw error
        })
    return configuration
}
export async function getFluxerAuthConfig() {
    const config = await getFluxerOAuthConfig()
    return {
        ...fluxerAuthPolicy(process.env.BETTER_AUTH_SECRET?.trim() ?? "", config.dashboardOrigin),
        provider: fluxerOAuthProvider(config),
    }
}

/** Preserves Better Auth's typed API while discovery initializes asynchronously. */
export function lazyAsyncAuth<T extends { api: object; handler: (...args: never[]) => unknown }>(
    create: () => Promise<T>
): T {
    let pending: Promise<T> | undefined
    const instance = () =>
        (pending ??= create().catch((error) => {
            pending = undefined
            throw error
        }))
    const api = new Proxy(
        {},
        {
            get:
                (_target, property) =>
                async (...args: unknown[]) => {
                    const auth = await instance()
                    const method = Reflect.get(auth.api, property) as (
                        ...args: unknown[]
                    ) => unknown
                    return Reflect.apply(method, auth.api, args)
                },
        }
    )
    return new Proxy({} as T, {
        has: (_target, property) => ["handler", "api", "$context"].includes(String(property)),
        get: (_target, property) => {
            if (property === "api") return api
            if (property === "$context")
                return instance().then((auth) => Reflect.get(auth, property))
            if (property === "handler")
                return async (...args: unknown[]) => {
                    const auth = await instance()
                    return Reflect.apply(auth.handler, auth, args)
                }
            return undefined
        },
    })
}
