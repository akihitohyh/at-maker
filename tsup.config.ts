import {defineConfig} from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        server: "src/server.ts",
    },
    outDir: "bundle",
    format: ["cjs"],
    target: "node20",
    platform: "node",
    splitting: false,
    sourcemap: false,
    clean: true,
    dts: false,
    noExternal: [
        "fetch-cookie",
        "tough-cookie",
        "undici",
        "socks",
    ],
    outExtension() {
        return {
            js: ".cjs",
        };
    },
});
