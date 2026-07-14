/**
 * Probe a registration proxy: TCP reachability + HTTPS fetch via proxy.
 * Supports http(s) and socks4/5 proxies (same stack as OpenAIClient).
 */
import net from "node:net";
import tls from "node:tls";
import {Agent, type Dispatcher, ProxyAgent, fetch as undiciFetch} from "undici";
import {SocksClient} from "socks";

export interface ProxyTestResult {
    ok: boolean;
    error?: string;
    latencyMs?: number;
    egressIp?: string;
    chatgptStatus?: number;
    proxyHost?: string;
    proxyPort?: string;
    protocol?: string;
}

function isSocksProtocol(protocol: string): boolean {
    return ["socks4:", "socks4a:", "socks5:", "socks5h:"].includes(protocol);
}

async function createSocksSocket(
    proxyUrl: URL,
    options: Record<string, unknown>,
    allowInsecureTLS: boolean,
): Promise<net.Socket> {
    const destinationHost = String(options.hostname ?? "");
    const rawPort = options.port;
    const destinationPort =
        rawPort === "" || rawPort == null
            ? options.protocol === "https:"
                ? 443
                : 80
            : Number(rawPort);
    const proxyPort = Number(proxyUrl.port || 1080);
    const proxyType = proxyUrl.protocol.startsWith("socks4") ? 4 : 5;

    const connection = await SocksClient.createConnection({
        proxy: {
            host: proxyUrl.hostname,
            port: proxyPort,
            type: proxyType,
            userId: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined,
        },
        command: "connect",
        destination: {
            host: destinationHost,
            port: destinationPort,
        },
    });

    const socket = connection.socket;
    if (options.protocol !== "https:") {
        return socket;
    }

    return await new Promise<net.Socket>((resolve, reject) => {
        const tlsSocket = tls.connect({
            socket,
            host: String(options.servername ?? destinationHost),
            servername: String(options.servername ?? destinationHost),
            rejectUnauthorized: !allowInsecureTLS,
        });
        tlsSocket.once("secureConnect", () => resolve(tlsSocket));
        tlsSocket.once("error", reject);
    });
}

function createDispatcher(proxyUrl: string): Dispatcher {
    const parsed = new URL(proxyUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return new ProxyAgent({
            uri: proxyUrl,
            requestTls: {rejectUnauthorized: false},
        });
    }
    if (isSocksProtocol(parsed.protocol)) {
        const connect = ((options, callback) => {
            void createSocksSocket(parsed, options as unknown as Record<string, unknown>, true)
                .then((socket) => callback(null, socket))
                .catch((error) =>
                    callback(error instanceof Error ? error : new Error(String(error)), null),
                );
        }) as NonNullable<ConstructorParameters<typeof Agent>[0]>["connect"];
        return new Agent({connect});
    }
    throw new Error(`不支持的代理协议: ${parsed.protocol}`);
}

export async function testProxyConnection(proxyUrlRaw: string): Promise<ProxyTestResult> {
    const proxyUrl = String(proxyUrlRaw || "").trim();
    if (!proxyUrl) {
        return {ok: false, error: "代理地址不能为空"};
    }

    let parsed: URL;
    try {
        parsed = new URL(proxyUrl);
    } catch {
        return {ok: false, error: "代理地址格式无效，请使用 http://user:pass@host:port"};
    }

    const protocol = parsed.protocol.replace(":", "");
    const proxyHost = parsed.hostname;
    const proxyPort = parsed.port || (protocol.startsWith("socks") ? "1080" : "80");

    const started = Date.now();
    let dispatcher: Dispatcher | null = null;

    try {
        dispatcher = createDispatcher(proxyUrl);

        // 1) Egress IP via proxy (quick proof the tunnel works)
        let egressIp = "";
        try {
            const ipResp = await undiciFetch("https://api.ipify.org?format=json", {
                dispatcher,
                signal: AbortSignal.timeout(15000),
                headers: {accept: "application/json"},
            });
            if (ipResp.ok) {
                const body = (await ipResp.json()) as {ip?: string};
                egressIp = String(body.ip || "").trim();
            }
        } catch {
            // fall through — still try chatgpt
        }

        // 2) Real target used by registration
        const chatResp = await undiciFetch("https://chatgpt.com/", {
            dispatcher,
            method: "GET",
            redirect: "follow",
            signal: AbortSignal.timeout(20000),
            headers: {
                "user-agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                accept: "text/html,application/xhtml+xml",
            },
        });

        const latencyMs = Date.now() - started;
        const chatgptStatus = chatResp.status;

        // 2xx/3xx/403 all mean the proxy path works (403 may be CF, still reachable)
        const reachable = chatgptStatus > 0 && chatgptStatus < 500;
        if (!reachable && !egressIp) {
            return {
                ok: false,
                error: `代理可达性异常: chatgpt.com HTTP ${chatgptStatus}`,
                latencyMs,
                chatgptStatus,
                proxyHost,
                proxyPort,
                protocol,
            };
        }

        return {
            ok: true,
            latencyMs,
            egressIp: egressIp || undefined,
            chatgptStatus,
            proxyHost,
            proxyPort,
            protocol,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const cause =
            err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
        return {
            ok: false,
            error: cause ? `${msg} (${cause})` : msg,
            latencyMs: Date.now() - started,
            proxyHost,
            proxyPort,
            protocol,
        };
    } finally {
        try {
            await dispatcher?.close?.();
        } catch {
            // ignore
        }
    }
}
