const SAFE_ERROR_SNIPPET_MAX = 200

/** Redacts bearer tokens and common OAuth secret patterns from log/error strings. */
export function redactTokenLikeString(s: string): string {
    let out = s
    out = out.replace(/bearer\s+\S+/gi, "Bearer [redacted]")
    out = out.replace(/access_token\s*=\s*\S+/gi, "access_token=[redacted]")
    out = out.replace(/refresh_token\s*=\s*\S+/gi, "refresh_token=[redacted]")
    out = out.replace(/client_secret\s*=\s*\S+/gi, "client_secret=[redacted]")
    // Escape-aware JSON string values so `"p\"ass"` cannot leave a trailing secret suffix.
    out = out.replace(/("access_token"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    out = out.replace(/("refresh_token"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    out = out.replace(/("client_secret"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    return out
}

/** Redacts verbose token payloads from thrown errors (keys-only for objects, truncated strings). */
export function safeJsonSnippet(value: unknown, maxLen = SAFE_ERROR_SNIPPET_MAX): string {
    if (value === null || value === undefined) {
        return String(value)
    }
    if (typeof value === "string") {
        const redacted = redactTokenLikeString(value)
        return redacted.length > maxLen ? `${redacted.slice(0, maxLen)}…` : redacted
    }
    if (typeof value === "object" && !Array.isArray(value) && value !== null) {
        const keys = Object.keys(value as Record<string, unknown>).slice(0, 16)
        return keys.length > 0 ? `{ keys: ${keys.join(", ")} }` : "{}"
    }
    let serialized: string
    try {
        serialized = JSON.stringify(value)
    } catch {
        serialized = "[unserializable]"
    }
    const redacted = redactTokenLikeString(serialized)
    return redacted.length > maxLen ? `${redacted.slice(0, maxLen)}…` : redacted
}
