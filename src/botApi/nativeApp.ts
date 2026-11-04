import express from "express"
import { incomingMessageToHeaders } from "./httpUtil.js"
import { handleMusicRequest, type MusicHttpDependencies } from "./musicHttp.js"
import {
    FluxerSessionError,
    requireFluxerActor,
    type AuthenticatedActor,
} from "../shared/fluxer-session.js"

export function validateMusicRequestOrigin(
    method: string,
    headers: Headers,
    dashboardOrigin: string
): boolean {
    return (
        ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) ||
        headers.get("origin") === dashboardOrigin
    )
}

/** Only native routes are mounted; legacy handlers cannot be reached through this application. */
export function createNativeBotApiApp(
    dependencies: MusicHttpDependencies,
    dashboardOrigin: string,
    authenticate: (headers: Headers) => Promise<AuthenticatedActor> = requireFluxerActor
): express.Express {
    const app = express()
    app.disable("x-powered-by")
    app.use(express.json({ limit: "1mb" }))
    app.use(async (req, res) => {
        const headers = incomingMessageToHeaders(req)
        if (!validateMusicRequestOrigin(req.method, headers, dashboardOrigin)) {
            res.status(403).json({ ok: false, error: { error: "Dashboard origin required" } })
            return
        }
        try {
            const actor = await authenticate(headers)
            const result = await handleMusicRequest(
                actor,
                { method: req.method, path: req.originalUrl, body: req.body },
                dependencies
            )
            res.status(result.status).json(result.body)
        } catch (error) {
            const status = error instanceof FluxerSessionError ? error.status : 503
            res.status(status).json({
                ok: false,
                error: {
                    error:
                        error instanceof FluxerSessionError
                            ? error.message
                            : "Session verification unavailable",
                },
            })
        }
    })
    const invalidJson: express.ErrorRequestHandler = (_error, _req, res, _next) => {
        void _next // Express identifies error middleware by its four-argument signature.
        res.status(400).json({ ok: false, error: { error: "Invalid request body" } })
    }
    app.use(invalidJson)
    return app
}
