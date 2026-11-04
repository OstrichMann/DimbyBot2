import { notFound } from "next/navigation"
import { PlayerPanel } from "@/components/PlayerPanel"
import { isFluxerId } from "@/shared/fluxer-user-id.js"

/** Player reads and mutations are authorized by the native Bot API using the forwarded session. */
export default async function GuildPage({ params }: { params: Promise<{ guildId: string }> }) {
    const { guildId } = await params
    if (!isFluxerId(guildId)) notFound()
    return (
        <section>
            <PlayerPanel guildId={guildId} />
        </section>
    )
}
