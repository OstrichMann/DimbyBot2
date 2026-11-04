import type { FluxerEndpoints } from "../../lib/fluxer/discovery.js"
import { isFluxerId } from "@/shared/fluxer-user-id.js"

export function buildFluxerBotInvite(
    endpoints: Pick<FluxerEndpoints, "webapp"> & Partial<FluxerEndpoints>,
    clientId: string,
    permissions: bigint
): string {
    if (!isFluxerId(clientId) || permissions < 0n || permissions >= 1n << 64n)
        throw new Error("Invalid Fluxer invite configuration")
    const url = new URL(`${endpoints.webapp}/oauth2/authorize`)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Invalid Fluxer invite origin")
    url.search = new URLSearchParams({
        client_id: clientId,
        scope: "bot",
        permissions: permissions.toString(),
    }).toString()
    return url.href
}
