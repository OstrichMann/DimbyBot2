import { getFluxerOAuthConfig } from "@/shared/fluxer-auth-config.js"
import { buildFluxerBotInvite } from "@/lib/fluxer-bot-invite"

export async function DashboardInviteLink() {
    try {
        const config = await getFluxerOAuthConfig()
        const href = buildFluxerBotInvite(config, config.clientId, 3165184n)
        return (
            <a
                className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
            >
                Add Bot to a server
            </a>
        )
    } catch {
        return (
            <span className="text-xs text-muted-foreground">
                Bot invite temporarily unavailable
            </span>
        )
    }
}
