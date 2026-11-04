"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import type { NativePlayerState, NativeQueueTrack } from "@/shared/fluxer-player-state.js"
import type { MusicTrack } from "@/shared/music-contract.js"
import {
    getMusicStateAction,
    getMusicQueueAction,
    mutateMusicAction,
    playMusicAction,
    searchMusicAction,
    type DashboardMusicAction,
} from "@/server/music.actions"
import { useNativePlayerSocket } from "@/hooks/useNativePlayerSocket"
import { queueEntryKey } from "@/lib/music-ui"
import { formatDurationMs } from "@/lib/format-duration"
import { sanitizeHttpUrl } from "@/lib/url-utils"
import { AddToPlaylistMenu } from "@/components/AddToPlaylistMenu"
import { PlayPlaylistMenu } from "@/components/PlayPlaylistMenu"

const button = "rounded border px-3 py-2 text-sm hover:bg-accent disabled:opacity-40"

export function PlayerPanel({ guildId }: { guildId: string }) {
    const [player, setPlayer] = useState<NativePlayerState | null>(null)
    const [queue, setQueue] = useState<NativeQueueTrack[]>([])
    const [page, setPage] = useState(1)
    const [query, setQuery] = useState("")
    const [results, setResults] = useState<MusicTrack[]>([])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [position, setPosition] = useState(0)
    const playerRef = useRef<NativePlayerState | null>(null)
    const generation = useRef(0)
    const live = useNativePlayerSocket(guildId)
    const apply = useCallback((next: NativePlayerState) => {
        if (next.revision < (playerRef.current?.revision ?? -1)) return false
        playerRef.current = next
        setPlayer(next)
        setPosition(next.positionMs)
        return true
    }, [])
    const refresh = useCallback(async () => {
        const request = ++generation.current
        const [state, upcoming] = await Promise.all([
            getMusicStateAction(guildId),
            getMusicQueueAction(guildId, page, 10),
        ])
        if (request !== generation.current) return
        if (state.ok === false) {
            setError(state.error)
            return
        }
        apply(state.data)
        if (upcoming.ok && upcoming.data.revision >= (playerRef.current?.revision ?? -1))
            setQueue(upcoming.data.items)
        else if (upcoming.ok === false) setError(upcoming.error)
    }, [guildId, page, apply])
    useEffect(() => {
        playerRef.current = null
        setPlayer(null)
        setQueue([])
        setPage(1)
        setError(null)
        return () => {
            generation.current++
        }
    }, [guildId])
    useEffect(() => {
        void refresh()
        const timer = setInterval(() => void refresh(), 15000)
        return () => {
            clearInterval(timer)
            generation.current++
        }
    }, [refresh])
    useEffect(() => {
        if (!live.update || !apply(live.update.state)) return
        if (page <= 10) setQueue(live.update.queue.slice((page - 1) * 10, page * 10))
        else void refresh()
    }, [live.update, page, apply, refresh])
    useEffect(() => {
        if (player?.status !== "playing") return
        const started = Date.now(),
            base = player.positionMs
        const timer = setInterval(
            () =>
                setPosition(
                    Math.min(
                        player.currentTrack?.durationMs || Infinity,
                        base + Date.now() - started
                    )
                ),
            500
        )
        return () => clearInterval(timer)
    }, [player])
    async function mutate(action: DashboardMusicAction) {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
            const result = await mutateMusicAction(guildId, action, playerRef.current?.revision)
            if (result.ok === false) setError(result.error)
            else apply(result.data)
            await refresh()
        } finally {
            setBusy(false)
        }
    }
    async function play(query: string) {
        if (busy || !query.trim()) return
        setBusy(true)
        setError(null)
        try {
            const result = await playMusicAction(guildId, query, playerRef.current?.revision)
            if (result.ok === false) setError(result.error)
            else {
                apply(result.data)
                setQuery("")
                setResults([])
            }
            await refresh()
        } finally {
            setBusy(false)
        }
    }
    const canControl = !!player?.inVoiceWithBot,
        canQueue = !!player?.canQueueTracks
    const current = player?.currentTrack
    const duration = current?.durationMs ?? 0
    const pages = Math.max(1, Math.ceil((player?.queueCount ?? 0) / 10))
    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-2xl font-semibold">Music</h1>
                <Link className="text-sm underline" href="/dashboard">
                    All servers
                </Link>
            </div>
            {error ? (
                <p
                    role="alert"
                    className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm"
                >
                    {error}
                </p>
            ) : null}
            {live.error ? (
                <p role="status" className="text-sm text-muted-foreground">
                    {live.error} Updates will also refresh periodically.
                </p>
            ) : null}
            {!canQueue && player ? (
                <p className="rounded border p-3 text-sm text-muted-foreground">
                    Join the Bot’s voice channel to queue or control music. For a new session, join
                    a voice channel first.
                </p>
            ) : null}
            <section className="space-y-4 rounded border bg-card p-4">
                <h2 className="text-lg font-medium">
                    {player?.status === "paused" ? "Paused" : "Now playing"}
                </h2>
                {current ? (
                    <div className="flex min-w-0 gap-4">
                        {sanitizeHttpUrl(current.thumbnailUrl) ? (
                            <img
                                src={sanitizeHttpUrl(current.thumbnailUrl)!}
                                alt=""
                                className="h-20 w-20 rounded object-cover"
                            />
                        ) : null}
                        <div className="min-w-0">
                            <a
                                className="break-words font-semibold hover:underline"
                                href={sanitizeHttpUrl(current.uri) ?? undefined}
                                target="_blank"
                                rel="noreferrer"
                            >
                                {current.title}
                            </a>
                            <p className="text-sm text-muted-foreground">{current.author}</p>
                            <p className="text-sm text-muted-foreground">
                                {formatDurationMs(position)} /{" "}
                                {current.isStream ? "LIVE" : formatDurationMs(duration)}
                            </p>
                            <AddToPlaylistMenu
                                track={{
                                    title: current.title,
                                    author: current.author,
                                    uri: current.sourceUri,
                                    durationMs: duration,
                                    thumbnailUrl: current.thumbnailUrl,
                                }}
                            />
                        </div>
                    </div>
                ) : (
                    <p className="text-muted-foreground">
                        {player ? "Nothing is playing." : "Loading player…"}
                    </p>
                )}
                <label className="block text-sm">
                    Playback position
                    <input
                        aria-label="Seek position"
                        type="range"
                        min={0}
                        max={Math.max(1, duration)}
                        step={1000}
                        value={Math.min(position, duration)}
                        disabled={
                            busy || !canControl || !current || current.isStream || duration <= 0
                        }
                        onChange={(event) => setPosition(Number(event.target.value))}
                        onPointerUp={(event) =>
                            void mutate({
                                type: "seek",
                                positionMs: Number(event.currentTarget.value),
                            })
                        }
                        onKeyUp={(event) => {
                            if (
                                [
                                    "ArrowLeft",
                                    "ArrowRight",
                                    "Home",
                                    "End",
                                    "PageUp",
                                    "PageDown",
                                ].includes(event.key)
                            )
                                void mutate({
                                    type: "seek",
                                    positionMs: Number(event.currentTarget.value),
                                })
                        }}
                        className="mt-2 w-full"
                    />
                </label>
                <div className="flex flex-wrap gap-2">
                    <button
                        className={button}
                        disabled={
                            busy ||
                            !current ||
                            (player?.status === "paused" ? !canQueue : !canControl)
                        }
                        onClick={() =>
                            void mutate({ type: player?.status === "paused" ? "resume" : "pause" })
                        }
                    >
                        {player?.status === "paused" ? "Resume" : "Pause"}
                    </button>
                    {(["skip", "stop", "leave", "shuffle"] as const).map((type) => (
                        <button
                            key={type}
                            className={button}
                            disabled={busy || !canControl}
                            onClick={() => void mutate({ type })}
                        >
                            {type[0].toUpperCase() + type.slice(1)}
                        </button>
                    ))}
                    <label className="flex items-center gap-2 text-sm">
                        Loop
                        <select
                            aria-label="Loop mode"
                            value={player?.loopMode ?? "off"}
                            disabled={busy || !canControl}
                            onChange={(event) =>
                                void mutate({
                                    type: "loop",
                                    mode: event.target.value as "off" | "track" | "queue",
                                })
                            }
                            className="rounded border bg-background p-2"
                        >
                            <option value="off">Off</option>
                            <option value="track">Track</option>
                            <option value="queue">Queue</option>
                        </select>
                    </label>
                </div>
                <label className="flex items-center gap-3 text-sm">
                    Volume
                    <input
                        aria-label="Volume"
                        className="min-w-0 flex-1"
                        type="range"
                        min={0}
                        max={100}
                        value={player?.volume ?? 100}
                        disabled={busy || !canControl}
                        onChange={(event) =>
                            setPlayer((state) =>
                                state ? { ...state, volume: Number(event.target.value) } : state
                            )
                        }
                        onPointerUp={(event) =>
                            void mutate({
                                type: "volume",
                                percent: Number(event.currentTarget.value),
                            })
                        }
                        onKeyUp={(event) => {
                            if (
                                [
                                    "ArrowLeft",
                                    "ArrowRight",
                                    "Home",
                                    "End",
                                    "PageUp",
                                    "PageDown",
                                ].includes(event.key)
                            )
                                void mutate({
                                    type: "volume",
                                    percent: Number(event.currentTarget.value),
                                })
                        }}
                    />
                    <span className="w-10">{player?.volume ?? 100}%</span>
                </label>
            </section>
            <section className="space-y-3 rounded border bg-card p-4">
                <h2 className="text-lg font-medium">Add music</h2>
                <form
                    onSubmit={(event) => {
                        event.preventDefault()
                        void play(query)
                    }}
                    className="flex flex-wrap gap-2"
                >
                    <label htmlFor="music-query" className="sr-only">
                        Song, artist or URL
                    </label>
                    <input
                        id="music-query"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Song, artist or URL"
                        className="min-w-0 flex-1 rounded border bg-background px-3 py-2"
                        maxLength={2048}
                    />
                    <button className={button} disabled={busy || !canQueue || !query.trim()}>
                        Queue
                    </button>
                    <button
                        type="button"
                        className={button}
                        disabled={busy || !query.trim()}
                        onClick={() => {
                            setBusy(true)
                            setError(null)
                            void searchMusicAction(guildId, query)
                                .then((result) => {
                                    if (result.ok === true) setResults(result.data.tracks)
                                    else setError(result.error)
                                })
                                .finally(() => setBusy(false))
                        }}
                    >
                        Search
                    </button>
                </form>
                {results.length ? (
                    <ul className="space-y-2">
                        {results.map((track) => (
                            <li
                                key={track.entryId}
                                className="flex items-center justify-between gap-3 border-b py-2"
                            >
                                <span className="min-w-0 break-words text-sm">
                                    {track.title}{" "}
                                    <span className="text-muted-foreground">{track.author}</span>
                                </span>
                                <button
                                    className={button}
                                    disabled={busy || !canQueue}
                                    onClick={() => void play(track.uri)}
                                >
                                    Queue
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : null}
                <PlayPlaylistMenu
                    guildId={guildId}
                    revision={player?.revision}
                    disabled={busy || !canQueue}
                    onQueued={() => void refresh()}
                />
            </section>
            <section className="space-y-3 rounded border bg-card p-4">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="text-lg font-medium">Queue · {player?.queueCount ?? 0}</h2>
                    <button
                        className={button}
                        disabled={busy || !canControl || !player?.queueCount}
                        onClick={() => void mutate({ type: "clear" })}
                    >
                        Clear upcoming
                    </button>
                </div>
                {queue.length ? (
                    <ol start={(page - 1) * 10 + 1} className="space-y-3">
                        {queue.map((track, index) => {
                            const absolute = (page - 1) * 10 + index
                            return (
                                <li
                                    key={queueEntryKey(track)}
                                    className="flex flex-wrap items-center justify-between gap-2 rounded border p-3"
                                >
                                    <div className="min-w-0 flex-1">
                                        <span className="break-words text-sm">
                                            {absolute + 1}. {track.title}
                                        </span>
                                        <p className="text-xs text-muted-foreground">
                                            {track.author} · {formatDurationMs(track.durationMs)}
                                        </p>
                                    </div>
                                    <div className="flex gap-1">
                                        <button
                                            className={button}
                                            aria-label={`Move ${track.title} up`}
                                            disabled={busy || !canControl || absolute === 0}
                                            onClick={() =>
                                                void mutate({
                                                    type: "move",
                                                    entryId: track.entryId,
                                                    toIndex: absolute - 1,
                                                })
                                            }
                                        >
                                            ↑
                                        </button>
                                        <button
                                            className={button}
                                            aria-label={`Move ${track.title} down`}
                                            disabled={
                                                busy ||
                                                !canControl ||
                                                absolute >= (player?.queueCount ?? 0) - 1
                                            }
                                            onClick={() =>
                                                void mutate({
                                                    type: "move",
                                                    entryId: track.entryId,
                                                    toIndex: absolute + 1,
                                                })
                                            }
                                        >
                                            ↓
                                        </button>
                                        <button
                                            className={button}
                                            disabled={busy || !canControl}
                                            onClick={() =>
                                                void mutate({
                                                    type: "remove",
                                                    entryId: track.entryId,
                                                })
                                            }
                                        >
                                            Remove
                                        </button>
                                    </div>
                                </li>
                            )
                        })}
                    </ol>
                ) : (
                    <p className="text-sm text-muted-foreground">No upcoming tracks.</p>
                )}
                <div className="flex items-center justify-between">
                    <button
                        className={button}
                        disabled={page <= 1}
                        onClick={() => setPage((value) => value - 1)}
                    >
                        Previous
                    </button>
                    <span className="text-sm">
                        Page {page} of {pages}
                    </span>
                    <button
                        className={button}
                        disabled={page >= pages}
                        onClick={() => setPage((value) => value + 1)}
                    >
                        Next
                    </button>
                </div>
            </section>
        </div>
    )
}
