import {
    FluxerSessionError,
    requireFluxerActor,
    type AuthenticatedActor,
} from "../fluxer-session.js"

/** Validate cookies before accepting a socket; URL parameters cannot supply identity or credentials. */
export async function authorizeFluxerUpgrade(
    headers: Headers,
    dashboardOrigin: string,
    authenticate: (headers: Headers) => Promise<AuthenticatedActor> = requireFluxerActor
): Promise<AuthenticatedActor> {
    if (headers.get("origin") !== dashboardOrigin)
        throw new FluxerSessionError(403, "Dashboard origin required")
    return authenticate(headers)
}
