import { readFluxerConfig } from "./fluxer/config.js"
import { discoverFluxer, type FluxerEndpoints } from "./fluxer/discovery.js"
import { FluxerRest } from "./fluxer/rest.js"
import { FluxerGateway, type FluxerDispatch } from "./fluxer/gateway.js"
import {
    FluxerEntities,
    fluxerRecord,
    normalizeFluxerMessage,
    type FluxerMessage,
} from "./fluxer/entities.js"
import { FluxerAccess } from "./fluxer/access.js"
import { FluxerVoice } from "./fluxer/voice.js"
import { FluxerDashboard } from "./fluxer/dashboard.js"
import { MusicService } from "./music/musicService.js"
import { PlaylistService } from "./music/playlistService.js"
import { SessionPersistence } from "./music/sessionPersistence.js"
import { ControlMessage } from "./music/controlMessage.js"
import { SourceResolver } from "./music/sourceResolver.js"
import { LavalinkSearch } from "./music/lavalinkSearch.js"
import { CompanionSource } from "./music/companionSource.js"
import { PublicMediaFetcher } from "./music/mediaFetch.js"
import { LivekitTransport } from "./music/livekitTransport.js"
import type { MusicTransport } from "./music/types.js"
import { NativeMusicStorage, type RuntimeStorage } from "../repositories/nativeMusicStorage.js"
import { FluxerOAuthAccounts } from "../shared/fluxer-oauth-accounts.js"
import { getFluxerOAuthConfig } from "../shared/fluxer-auth-config.js"
import { dispatchCommand } from "../commands/dispatchCommand.js"
import type { LoggerInterface } from "../types/index.js"

type RuntimeGateway = Pick<FluxerGateway, "ready" | "start" | "stop" | "send">
interface RuntimeOptions {
    env?: NodeJS.ProcessEnv
    storage?: RuntimeStorage
    discover?: typeof discoverFluxer
    createRest?: (api: string, token: string) => Pick<FluxerRest, "request">
    createGateway?: (
        endpoint: string,
        token: string,
        dependencies: ConstructorParameters<typeof FluxerGateway>[2]
    ) => RuntimeGateway
    resolver?: Pick<SourceResolver, "load" | "prepare" | "search">
    createTransport?: (guildId: string) => MusicTransport
    probeSources?: () => Promise<void>
    dispose?: () => Promise<void>
}
function origin(value: string | undefined, name: string): string {
    try {
        const url = new URL(value ?? "")
        if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash
        )
            throw new Error()
        return url.origin
    } catch {
        throw new Error(`Configure ${name} as an HTTP(S) origin`)
    }
}

/** Native Fluxer composition root. Only music commands and services are activated. */
export default class BotClient {
    readonly entities = new FluxerEntities()
    rest: Pick<FluxerRest, "request">
    gateway: RuntimeGateway
    voice: FluxerVoice
    access: FluxerAccess
    music: MusicService
    playlists: PlaylistService
    dashboard: FluxerDashboard
    endpoints: FluxerEndpoints
    readonly storage: RuntimeStorage
    private persistence: SessionPersistence
    private controlMessage: ControlMessage
    private readonly requests = new AbortController()
    private readonly tasks = new Set<Promise<unknown>>()
    private readonly waitingMessages: FluxerMessage[] = []
    private readonly invalidators = new Set<(guildId: string) => void>()
    private readonly platformChecks = new Map<string, { dirty: boolean }>()
    private resolver: Pick<SourceResolver, "load" | "prepare" | "search">
    private initialized = false
    private closing = false
    private nativeUsed = false
    private storageOpened = false
    private starting?: Promise<void>
    private stopping?: Promise<void>
    constructor(
        readonly logger: Pick<LoggerInterface, "debug" | "info" | "warn" | "error">,
        private readonly options: RuntimeOptions = {}
    ) {
        this.storage = options.storage ?? new NativeMusicStorage(logger)
    }
    get ready(): boolean {
        return this.initialized && !this.closing && this.gateway?.ready === true
    }
    start(): Promise<void> {
        return (this.starting ??= this.initialize().catch(async (error) => {
            await this.destroy()
            throw error
        }))
    }
    private async initialize(): Promise<void> {
        const env = this.options.env ?? process.env,
            config = readFluxerConfig(env)
        const metadataOrigin = origin(env.LAVALINK_ORIGIN, "LAVALINK_ORIGIN"),
            companionOrigin = origin(env.INVIDIOUS_COMPANION_URL, "INVIDIOUS_COMPANION_URL")
        if (!env.LAVALINK_PASSWORD?.trim() || !env.INVIDIOUS_COMPANION_KEY?.trim())
            throw new Error("Configure LAVALINK_PASSWORD and INVIDIOUS_COMPANION_KEY")
        if (!/^[a-zA-Z0-9]{16}$/.test(env.INVIDIOUS_COMPANION_KEY))
            throw new Error(
                "INVIDIOUS_COMPANION_KEY must contain exactly 16 alphanumeric characters"
            )
        this.endpoints = await (this.options.discover ?? discoverFluxer)(config.instanceOrigin)
        const rest = (this.options.createRest ?? ((api, token) => new FluxerRest(api, token)))(
            this.endpoints.api,
            config.token
        )
        this.rest = {
            request: (method, path, options = {}) =>
                rest.request(method, path, {
                    ...options,
                    signal: AbortSignal.any([
                        this.requests.signal,
                        ...(options.signal ? [options.signal] : []),
                    ]),
                }),
        }
        const me = fluxerRecord(await this.rest.request("GET", "/users/@me"))
        if (me.id !== config.clientId || me.bot !== true)
            throw new Error("Fluxer bot identity does not match FLUXER_CLIENT_ID")
        this.storageOpened = true
        await this.storage.start()
        const probe =
            this.options.probeSources ??
            (async () => {
                try {
                    const response = await fetch(`${metadataOrigin}/v4/info`, {
                        headers: { Authorization: env.LAVALINK_PASSWORD! },
                        redirect: "error",
                        signal: AbortSignal.timeout(10000),
                    })
                    if (!response.ok) throw new Error()
                } catch {
                    throw new Error("Music metadata service unavailable")
                }
            })
        await probe()
        this.gateway = (
            this.options.createGateway ??
            ((endpoint, token, dependencies) => new FluxerGateway(endpoint, token, dependencies))
        )(this.endpoints.gateway, config.token, {
            onDispatch: (event) => this.accept(event),
            onError: () => this.logger.warn("Fluxer Gateway connection failed"),
        })
        this.voice = new FluxerVoice({
            send: (op, data) => this.gateway.send(op, data),
            onDisconnect: (guildId) => this.platformChanged(guildId),
        })
        this.access = new FluxerAccess({
            rest: this.rest,
            entities: this.entities,
            botId: config.clientId,
            isReady: () => this.gateway.ready,
            botChannelId: (guildId) => this.voice.channelId(guildId),
        })
        const resolver =
            this.options.resolver ??
            new SourceResolver({
                metadata: new LavalinkSearch({
                    origin: metadataOrigin,
                    password: env.LAVALINK_PASSWORD,
                }),
                companion: new CompanionSource({
                    origin: companionOrigin,
                    secret: env.INVIDIOUS_COMPANION_KEY,
                }),
                media: new PublicMediaFetcher(),
            })
        this.resolver = resolver
        this.music = new MusicService({
            access: this.access,
            voice: this.voice,
            resolver,
            transportFactory:
                this.options.createTransport ??
                (() => {
                    this.nativeUsed = true
                    return new LivekitTransport()
                }),
            verifyBotAccess: (guildId, channelId) => this.access.verifyBotVoice(guildId, channelId),
            hasListeners: (guildId, channelId) =>
                [...(this.entities.getGuild(guildId)?.voice.values() ?? [])].some(
                    (entry) => entry.channelId === channelId && entry.userId !== config.clientId
                ),
            onError: () => this.logger.warn("Native music operation failed"),
        })
        this.playlists = new PlaylistService({ resolver })
        this.persistence = new SessionPersistence({
            service: this.music,
            store: this.storage.sessions,
            canRestore: async (row) => {
                try {
                    await this.access.verifyBotVoice(row.guildId, row.voiceChannelId)
                    return true
                } catch {
                    return false
                }
            },
            onError: () => this.logger.warn("Native music snapshot save failed"),
        })
        this.controlMessage = new ControlMessage({
            music: this.music,
            rest: this.rest,
            settings: (guildId) => this.storage.settings(guildId),
            saveMessageId: (guildId, channelId, id) =>
                this.storage.saveMessageId(guildId, channelId, id),
            onError: () => this.logger.warn("Native control message update failed"),
        })
        // OAuth discovery/secrets stay lazy; prefix music can run before the Dashboard is configured.
        this.dashboard = new FluxerDashboard({
            entities: this.entities,
            music: this.music,
            access: this.access,
            accounts: {
                accessToken: async (userId) =>
                    new FluxerOAuthAccounts(
                        await getFluxerOAuthConfig(),
                        env.BETTER_AUTH_SECRET ?? ""
                    ).accessToken(userId),
            },
            ready: () => this.ready,
            botChannelId: (guildId) => this.voice.channelId(guildId),
            endpoints: this.endpoints,
            clientId: config.clientId,
        })
        await this.gateway.start()
        await this.persistence.restore()
        this.initialized = true
        for (const message of this.waitingMessages.splice(0)) this.command(message)
        this.logger.info("Fluxer music Bot is ready")
    }
    private background(work: Promise<unknown>): void {
        const task = work
            .catch(() => {
                if (!this.closing) this.logger.warn("Native background operation failed")
            })
            .finally(() => this.tasks.delete(task))
        this.tasks.add(task)
    }
    private platformChanged(guildId: string): void {
        if (this.closing) return
        for (const invalidate of this.invalidators) invalidate(guildId)
        if (!this.music) return
        const pending = this.platformChecks.get(guildId)
        if (pending) {
            pending.dirty = true
            return
        }
        const check = { dirty: true }
        this.platformChecks.set(guildId, check)
        this.background(
            (async () => {
                try {
                    while (check.dirty && !this.closing) {
                        check.dirty = false
                        await this.music.onPlatformChange(guildId)
                    }
                } finally {
                    this.platformChecks.delete(guildId)
                }
            })()
        )
    }
    onAccessChange(callback: (guildId: string) => void): () => void {
        this.invalidators.add(callback)
        return () => {
            this.invalidators.delete(callback)
        }
    }
    private async accept(event: FluxerDispatch): Promise<void> {
        if (this.closing) return
        const data = fluxerRecord(event.d)
        if (event.t === "MESSAGE_CREATE") {
            const message = normalizeFluxerMessage(event.d)
            if (!message || message.bot || message.webhook || !message.guildId) return
            if (this.tasks.size + this.waitingMessages.length >= 1000)
                throw new Error("Native command queue is full")
            if (!this.initialized) this.waitingMessages.push(message)
            else this.command(message)
            return
        }
        const affected =
            event.t === "READY"
                ? (this.music?.allSnapshots().map((snapshot) => snapshot.guildId) ?? [])
                : [
                      typeof data.guild_id === "string"
                          ? data.guild_id
                          : typeof data.id === "string" && event.t.startsWith("GUILD_")
                            ? data.id
                            : "",
                  ]
        this.entities.apply(event)
        this.voice?.handleDispatch(event)
        for (const guildId of affected) if (guildId) this.platformChanged(guildId)
        if (event.t === "GUILD_CREATE" && this.initialized)
            this.background(this.persistence.restore())
    }
    private command(message: FluxerMessage): void {
        if (this.closing) return
        this.background(
            dispatchCommand(message, {
                prefix: (this.options.env ?? process.env).BOT_COMMAND_PREFIX ?? "!",
                rest: this.rest,
                music: this.music,
                playlists: this.playlists,
                access: this.access,
                controlChannel: (guildId) => this.storage.settings(guildId).channelId,
                setControlChannel: (guildId, channelId) =>
                    this.storage.setControlChannel(guildId, channelId),
                validateControlChannel: async (actor, channelId) => {
                    await this.access.authorizeMusic(actor, "configure", channelId)
                },
                onError: () => {
                    if (!this.closing) this.logger.warn("Native command failed")
                },
            })
        )
    }
    search(query: string, requesterId: string, signal: AbortSignal) {
        return this.resolver.search(query, requesterId, signal)
    }
    destroy(): Promise<void> {
        return (this.stopping ??= this.shutdown())
    }
    private async shutdown(): Promise<void> {
        this.closing = true
        this.initialized = false
        this.waitingMessages.length = 0
        this.controlMessage?.stop()
        this.requests.abort()
        const failures: unknown[] = []
        const cleanup = async (work: () => Promise<unknown>) => {
            try {
                await work()
            } catch (error) {
                failures.push(error)
            }
        }
        await cleanup(async () => this.music?.shutdown())
        await cleanup(async () => this.persistence?.shutdown())
        await cleanup(async () => this.voice?.stop())
        await cleanup(async () => this.gateway?.stop())
        await Promise.allSettled([...this.tasks])
        this.invalidators.clear()
        await cleanup(async () => {
            if (this.options.dispose) await this.options.dispose()
            else if (this.nativeUsed) await (await import("@livekit/rtc-node")).dispose()
        })
        if (this.storageOpened) await cleanup(() => this.storage.close())
        if (failures.length) throw new Error("Native Bot shutdown encountered an error")
    }
}
