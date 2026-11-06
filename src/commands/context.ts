import type { FluxerAccess } from "../lib/fluxer/access.js"
import type { FluxerRest } from "../lib/fluxer/rest.js"
import type { MusicService, MusicActor } from "../lib/music/musicService.js"
import type { PlaylistService } from "../lib/music/playlistService.js"

export interface CommandDependencies {
    prefix: string
    music: Pick<MusicService, "execute" | "snapshot" | "requiredAccess">
    playlists: Pick<PlaylistService, "execute">
    access: Pick<FluxerAccess, "authorizeMusic">
    rest: Pick<FluxerRest, "request">
    controlChannel(guildId: string): string | null
    setControlChannel(guildId: string, channelId: string | null): Promise<void>
    validateControlChannel(actor: MusicActor, channelId: string): Promise<void>
    onError?: (message: string) => void
}
export interface CommandContext {
    actor: MusicActor
    dependencies: CommandDependencies
}
