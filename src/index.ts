import {appConfig} from "./config.js";
import {readPositiveIntArg} from "./cli-args.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {OpenAIClient} from "./openai.js";

async function runOnce(): Promise<void> {
    const deviceProfile = generateRandomDeviceProfile();
    const client = new OpenAIClient({
        password: appConfig.defaultPassword,
        deviceProfile,
    });
    await client.authRegisterHTTP();
    const session = await client.getChatGPTSession();

    let refreshToken = "";
    let idToken = "";
    let platformAccessToken = "";
    try {
        console.log("[OAuth PKCE] 获取 refresh_token...");
        const oauth = await client.getPlatformOAuthTokens();
        if (oauth?.refresh_token) {
            refreshToken = oauth.refresh_token;
            idToken = oauth.id_token || "";
            platformAccessToken = oauth.access_token || "";
            console.log("[OAuth PKCE] 成功，已拿到 RT");
        } else {
            console.log("[OAuth PKCE] 未获取到 refresh_token");
        }
    } catch (err) {
        console.log(
            `[OAuth PKCE] 警告: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    const accessTokenFile = await client.saveChatGPTAccessToken(session.accessToken, {
        refreshToken,
        idToken,
        sessionToken: session.sessionToken,
        platformAccessToken,
    });
    console.log(`[✅️注册成功] 邮箱：${client.email} 密码：${appConfig.defaultPassword}`);
    console.log(`[access_token_file] ${accessTokenFile}`);
    console.log(`[access_token] ${session.accessToken}`);
    if (refreshToken) {
        console.log(`[refresh_token] ${refreshToken.slice(0, 24)}...`);
    }
}

async function main() {
    const maxRounds = readPositiveIntArg("--n") ?? 1;
    const threads = readPositiveIntArg("--threads") ?? 1;
    const total = Math.max(1, maxRounds);

    let round = 0, success = 0, fail = 0;

    function nextRound(): number {
        round += 1;
        return round;
    }

    async function worker(id: number) {
        for (;;) {
            const r = nextRound();
            if (r > total) break;
            console.log(`[线程${id}] 第 ${r}/${total} 轮开始: 成功=${success} 失败=${fail}`);
            try {
                await runOnce();
                success += 1;
            } catch (error) {
                fail += 1;
                console.error(`[线程${id}] [❌️注册失败]`, error);
            }
            const remaining = total - r;
            if (remaining > 0 && appConfig.loopDelayMs > 0) {
                await new Promise(r => setTimeout(r, appConfig.loopDelayMs));
            }
        }
    }

    console.log(`启动 ${Math.min(threads, total)} 线程, 共 ${total} 轮`);
    const workers = [];
    for (let i = 1; i <= Math.min(threads, total); i++) {
        workers.push(worker(i));
    }
    await Promise.all(workers);

    console.log(`结束: 总数=${total} 成功=${success} 失败=${fail}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
