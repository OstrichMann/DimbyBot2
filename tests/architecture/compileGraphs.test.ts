import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

function walk(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(directory, entry.name)
        return entry.isDirectory() ? walk(file) : [file]
    })
}
function graph(roots: string[]) {
    const base = process.cwd()
    const options = (file: string) => {
        const config = file.startsWith("src/web/") ? "src/web/tsconfig.json" : "tsconfig.json"
        return ts.parseJsonConfigFileContent(
            ts.readConfigFile(config, ts.sys.readFile).config,
            ts.sys,
            path.dirname(path.resolve(config))
        ).options
    }
    const files = new Set<string>(),
        packages = new Set<string>(),
        queue = [...roots]
    while (queue.length) {
        const file = queue.pop()!
        if (files.has(file)) continue
        files.add(file)
        const source = ts.createSourceFile(
            file,
            fs.readFileSync(file, "utf8"),
            ts.ScriptTarget.Latest,
            true
        )
        const imports: string[] = []
        const visit = (node: ts.Node) => {
            if (
                (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
                node.moduleSpecifier &&
                ts.isStringLiteral(node.moduleSpecifier)
            )
                imports.push(node.moduleSpecifier.text)
            if (
                ts.isImportTypeNode(node) &&
                ts.isLiteralTypeNode(node.argument) &&
                ts.isStringLiteral(node.argument.literal)
            )
                imports.push(node.argument.literal.text)
            if (
                ts.isCallExpression(node) &&
                node.expression.kind === ts.SyntaxKind.ImportKeyword &&
                node.arguments[0] &&
                ts.isStringLiteral(node.arguments[0])
            )
                imports.push(node.arguments[0].text)
            ts.forEachChild(node, visit)
        }
        visit(source)
        for (const name of imports) {
            const resolved = ts.resolveModuleName(
                name,
                path.resolve(file),
                options(file),
                ts.sys
            ).resolvedModule
            if (resolved && !resolved.resolvedFileName.includes("/node_modules/"))
                queue.push(path.relative(base, resolved.resolvedFileName))
            else if (!name.startsWith(".") && !name.startsWith("@/")) packages.add(name)
        }
    }
    return { files: [...files], packages: [...packages] }
}

test("Dashboard compile graph cannot import Bot runtime or player/voice SDKs, including through shared types", () => {
    const roots = walk("src/web/app").filter((file) =>
        /\/(page|layout|route|loading|error|not-found)\.tsx?$/.test(file)
    )
    roots.push("src/web/proxy.ts")
    const result = graph(roots)
    assert.deepEqual(
        result.files.filter((file) =>
            /^src\/lib\/(BotClient|botClientRegistry|music\/)/.test(file)
        ),
        []
    )
    assert.deepEqual(
        result.packages.filter((name) =>
            /^(discord\.js|@discordjs\/|lavalink-client|@livekit\/)/.test(name)
        ),
        []
    )
})
test("Bot startup graph contains no Discord/deferred runtime, Dashboard modules, or archived source", () => {
    const result = graph(["src/server.ts"])
    assert.deepEqual(
        result.files.filter(
            (file) =>
                file.startsWith("src/web/") ||
                file.startsWith("legacy/") ||
                /(?:countdown|youtubeUploadMonitor|loadCommands|loadEvents)/.test(file)
        ),
        []
    )
    assert.deepEqual(
        result.packages.filter((name) =>
            /^(discord\.js|@discordjs\/|lavalink-client|@snazzah\/davey|opusscript|sodium)/.test(
                name
            )
        ),
        []
    )
})
