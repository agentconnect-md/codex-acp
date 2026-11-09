import {spawn} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {PERMISSION_PROFILE_CONFIG_ENV} from "../PermissionProfileConfig";
import {CodexAppServerSupervisor} from "../app-server-recovery/CodexAppServerSupervisor";
import {fakeAppServer} from "./app-server-recovery/fake-app-server";

const PROFILE_CONFIG = JSON.stringify({
    configOverrides: ['default_permissions="external-agent"', 'permissions.external-agent.extends=":workspace"'],
    modeProfiles: {"read-only": "external-read-only", agent: "external-agent", "agent-full-access": "external-full-access"},
});

const dirs: string[] = [];

afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});

/** A stand-in Codex binary that records its arguments and whether the launcher's profile config reached it, then exits. */
function recordingCodex(): {codexPath: string, record: string} {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-profile-env-"));
    dirs.push(dir);
    const record = path.join(dir, "record.json");
    const codexPath = path.join(dir, "codex");
    fs.writeFileSync(codexPath, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({
    args: process.argv.slice(2),
    profileConfig: process.env[${JSON.stringify(PERMISSION_PROFILE_CONFIG_ENV)}] ?? null,
}));
`);
    fs.chmodSync(codexPath, 0o755);
    return {codexPath, record};
}

async function readRecord(record: string): Promise<{args: string[], profileConfig: string | null}> {
    await vi.waitFor(() => expect(fs.existsSync(record)).toBe(true), {timeout: 20_000, interval: 50});
    return JSON.parse(fs.readFileSync(record, "utf8"));
}

describe.skipIf(process.platform === "win32")("launcher permission profile config", () => {
    it("reaches the first app-server as -c overrides, never as its environment", async () => {
        const {codexPath, record} = recordingCodex();
        const agent = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
            cwd: process.cwd(),
            env: {...process.env, CODEX_PATH: codexPath, [PERMISSION_PROFILE_CONFIG_ENV]: PROFILE_CONFIG},
            stdio: ["pipe", "ignore", "ignore"],
        });
        try {
            const {args, profileConfig} = await readRecord(record);

            expect(args).toEqual([
                "app-server",
                "-c", 'default_permissions="external-agent"',
                "-c", 'permissions.external-agent.extends=":workspace"',
            ]);
            expect(profileConfig).toBeNull();
        } finally {
            agent.kill();
        }
    }, 30_000);

    it("stays out of a restarted app-server's environment", async () => {
        vi.stubEnv(PERMISSION_PROFILE_CONFIG_ENV, PROFILE_CONFIG);
        const {codexPath, record} = recordingCodex();
        const initial = fakeAppServer();
        const env = {...process.env};
        delete env[PERMISSION_PROFILE_CONFIG_ENV];
        const supervisor = new CodexAppServerSupervisor({connection: initial.connection, codexPath, env, stderr: ""});
        initial.child.die(0, null);
        await supervisor.current.exited;

        supervisor.spawn();

        expect((await readRecord(record)).profileConfig).toBeNull();
        supervisor.shutdown();
    }, 30_000);
});
