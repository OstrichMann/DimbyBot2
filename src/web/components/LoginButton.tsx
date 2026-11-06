"use client"

import { useState } from "react"
import { Music2 } from "lucide-react"
import { authClient } from "@/auth-client"

export function LoginButton() {
    const [signing, setSigning] = useState(false)
    const [error, setError] = useState<string | null>(null)
    return (
        <div className="flex flex-col items-center gap-3">
            <button
                type="button"
                disabled={signing}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                onClick={() => {
                    if (signing) return
                    setSigning(true)
                    setError(null)
                    void authClient.signIn
                        .oauth2({
                            providerId: "fluxer",
                            callbackURL: "/dashboard",
                            errorCallbackURL: "/auth/error",
                        })
                        .then((result) => {
                            if (result.error) setError("Sign-in failed. Please try again.")
                        })
                        .catch(() => setError("Sign-in failed. Please try again."))
                        .finally(() => setSigning(false))
                }}
            >
                <Music2 aria-hidden="true" className="h-5 w-5" />
                {signing ? "Opening Fluxer…" : "Sign in with Fluxer"}
            </button>
            {error ? (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            ) : null}
        </div>
    )
}
