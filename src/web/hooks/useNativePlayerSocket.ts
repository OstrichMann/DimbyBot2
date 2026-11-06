"use client"

import { useEffect, useState } from "react"
import {
    acceptsNativePlayerUpdate,
    type NativePlayerState,
    type NativeQueueTrack,
} from "@/shared/fluxer-player-state.js"
import { playerWsFallbackProtocol, rewriteLocalDevPlayerWsUrl } from "@/shared/player-ws-url.js"

export function useNativePlayerSocket(guildId: string) {
    const [update, setUpdate] = useState<{
        state: NativePlayerState
        queue: NativeQueueTrack[]
    } | null>(null)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        let closed = false,
            socket: WebSocket | undefined,
            attempts = 0
        let retry: ReturnType<typeof setTimeout> | undefined,
            heartbeat: ReturnType<typeof setInterval> | undefined
        setUpdate(null)
        const connect = async () => {
            try {
                const response = await fetch("/api/ws-config", { credentials: "include" })
                const config = (await response.json()) as { wsUrl?: string }
                if (closed) return
                const fallback = `${playerWsFallbackProtocol({ isDev: process.env.NODE_ENV === "development", pageProtocol: window.location.protocol, hostname: window.location.hostname }) + ":"}//${window.location.host}/ws`
                const url = new URL(config.wsUrl || fallback)
                if (
                    !["ws:", "wss:"].includes(url.protocol) ||
                    url.username ||
                    url.password ||
                    url.search ||
                    url.hash
                )
                    throw new Error("Invalid live update URL")
                const resolved = rewriteLocalDevPlayerWsUrl(
                    url.href,
                    process.env.NODE_ENV === "development"
                )
                socket = new WebSocket(resolved)
                socket.onopen = () => {
                    attempts = 0
                    setError(null)
                    socket?.send(JSON.stringify({ type: "subscribe", guildId }))
                    heartbeat = setInterval(() => {
                        if (socket?.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}')
                    }, 30000)
                }
                socket.onmessage = (event) => {
                    try {
                        const frame = JSON.parse(String(event.data))
                        if (frame.type === "error") {
                            setError(
                                typeof frame.message === "string"
                                    ? frame.message
                                    : "Live updates unavailable"
                            )
                            return
                        }
                        if (
                            frame.type === "queueUpdate" &&
                            frame.guildId === guildId &&
                            frame.state?.guildId === guildId &&
                            typeof frame.state.instanceId === "string" &&
                            Number.isSafeInteger(frame.state.revision) &&
                            Array.isArray(frame.queue)
                        ) {
                            setError(null)
                            setUpdate((previous) =>
                                acceptsNativePlayerUpdate(previous?.state ?? null, frame.state)
                                    ? { state: frame.state, queue: frame.queue }
                                    : previous
                            )
                        }
                    } catch {
                        setError("Unable to read live update")
                    }
                }
                socket.onerror = () => setError("Live connection unavailable")
                socket.onclose = () => {
                    clearInterval(heartbeat)
                    if (!closed && attempts++ < 12)
                        retry = setTimeout(
                            () => void connect(),
                            Math.min(30000, 1000 * 2 ** attempts)
                        )
                    else if (!closed) setError("Live updates disconnected. Refresh to reconnect.")
                }
            } catch {
                if (!closed) {
                    setError("Live connection unavailable")
                    if (attempts++ < 12)
                        retry = setTimeout(
                            () => void connect(),
                            Math.min(30000, 1000 * 2 ** attempts)
                        )
                }
            }
        }
        void connect()
        return () => {
            closed = true
            clearTimeout(retry)
            clearInterval(heartbeat)
            socket?.close()
        }
    }, [guildId])
    return { update, error }
}
