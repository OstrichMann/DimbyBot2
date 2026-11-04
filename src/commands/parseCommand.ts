export interface ParsedCommand {
    name: string
    args: string[]
    remainder: string
}

/** Quotes group arguments only at token boundaries; apostrophes in song titles remain ordinary text. */
export function parseCommand(content: string, prefix: string): ParsedCommand | null {
    if (!prefix || !content.startsWith(prefix)) return null
    const text = content.slice(prefix.length).trimStart()
    const name = /^\S*/.exec(text)![0].toLowerCase()
    const remainder = text.slice(name.length).trimStart()
    const args: string[] = []
    let token = "",
        quote: string | undefined,
        started = false
    for (let index = 0; index < remainder.length; index++) {
        const char = remainder[index]
        if (quote) {
            if (char === quote) quote = undefined
            else if (char === "\\" && remainder[index + 1] === quote) token += remainder[++index]
            else token += char
        } else if (/\s/.test(char)) {
            if (started) {
                args.push(token)
                token = ""
                started = false
            }
        } else if (!started && (char === '"' || char === "'")) {
            quote = char
            started = true
        } else {
            token += char
            started = true
        }
    }
    if (quote) throw new Error("Close the quoted argument")
    if (started) args.push(token)
    return { name, args, remainder }
}

/** Prefix commands accept decimal seconds or mm:ss, without JavaScript numeric syntax. */
export function parseSeekMs(text: string): number | null {
    let seconds: number
    if (/^\d+(?:\.\d+)?$/.test(text)) seconds = Number(text)
    else {
        const match = /^(\d+):([0-5]\d)$/.exec(text)
        if (!match) return null
        seconds = Number(match[1]) * 60 + Number(match[2])
    }
    return Number.isSafeInteger(Math.floor(seconds * 1000)) ? seconds * 1000 : null
}
