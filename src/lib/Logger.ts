import fs from "node:fs"
import path from "node:path"
import winston from "winston"
import type { LoggerInterface } from "../types/index.js"

/** Local console/file logging has no platform forwarding, jobs or network side effects. */
export default class Logger implements LoggerInterface {
    private debugEnabled = process.env.LOG_LEVEL?.toLowerCase() === "debug"
    private readonly logger: winston.Logger
    constructor(private readonly file: string | null = null) {
        if (file) fs.mkdirSync(path.dirname(file), { recursive: true })
        this.logger = winston.createLogger({
            level: "debug",
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.printf(
                    ({ timestamp, level, message }) =>
                        `${timestamp} [${level.toUpperCase()}] ${message}`
                )
            ),
            transports: [
                new winston.transports.Console(),
                ...(file ? [new winston.transports.File({ filename: file })] : []),
            ],
        })
    }
    private write(level: "info" | "warn" | "error" | "debug", text: string, args: unknown[]): void {
        if (level === "debug" && !this.debugEnabled) return
        const details = args
            .map((value) =>
                value instanceof Error
                    ? value.message
                    : typeof value === "string"
                      ? value
                      : "[detail omitted]"
            )
            .join(" ")
        this.logger.log(level, text + (details ? ` ${details}` : ""))
    }
    info(text: string, ...args: unknown[]): void {
        this.write("info", text, args)
    }
    warn(text: string, ...args: unknown[]): void {
        this.write("warn", text, args)
    }
    error(text: string, ...args: unknown[]): void {
        this.write("error", text, args)
    }
    debug(text: string, ...args: unknown[]): void {
        this.write("debug", text, args)
    }
    setDebugEnabled(enabled: boolean): void {
        this.debugEnabled = enabled
    }
    getDebugEnabled(): boolean {
        return this.debugEnabled
    }
    getLogFilePath(): string | null {
        return this.file
    }
}
