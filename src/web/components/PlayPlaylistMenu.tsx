"use client"

import { useState } from "react"
import type { PlaylistSummary } from "@/types/web"
import { getPlaylistsAction, playPlaylistInGuildAction } from "@/server/playlists.actions"

export function PlayPlaylistMenu({
    guildId,
    revision,
    disabled,
    onQueued,
}: {
    guildId: string
    revision?: number
    disabled?: boolean
    onQueued?: () => void
}) {
    const [lists, setLists] = useState<PlaylistSummary[]>([])
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    return (
        <div className="space-y-2">
            <button
                type="button"
                disabled={disabled || busy}
                className="rounded border px-3 py-2 text-sm disabled:opacity-40"
                onClick={() => {
                    setBusy(true)
                    setError(null)
                    void getPlaylistsAction()
                        .then((result) => {
                            if (result.ok === true) {
                                setLists(result.data.playlists)
                                setOpen(true)
                            } else setError(result.error)
                        })
                        .finally(() => setBusy(false))
                }}
            >
                Queue a playlist
            </button>
            {open ? (
                <div className="flex flex-wrap gap-2">
                    {lists.length ? (
                        lists.map((list) => (
                            <button
                                type="button"
                                className="rounded border px-3 py-2 text-sm disabled:opacity-40"
                                disabled={disabled || busy || !list.trackCount}
                                key={list.id}
                                onClick={() => {
                                    setBusy(true)
                                    setError(null)
                                    void playPlaylistInGuildAction(guildId, list.id, revision)
                                        .then((result) => {
                                            if (result.ok === true) {
                                                setOpen(false)
                                                onQueued?.()
                                            } else setError(result.error)
                                        })
                                        .finally(() => setBusy(false))
                                }}
                            >
                                {list.name} ({list.trackCount})
                            </button>
                        ))
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            Create a playlist on the Playlists page first.
                        </p>
                    )}
                </div>
            ) : null}
            {error ? (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            ) : null}
        </div>
    )
}
