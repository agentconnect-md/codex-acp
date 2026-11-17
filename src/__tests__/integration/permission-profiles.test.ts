import {expect, it} from "vitest";
import {createServer} from "node:http";
import * as acp from "@agentclientprotocol/sdk/unstable";
import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {legacySetSessionModel} from "../../AcpExtensions";
import type {AddressInfo} from "node:net";
import {PERMISSION_PROFILE_CONFIG_ENV} from "../../PermissionProfileConfig";
import {createSpawnedAgentFixture, type SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {agentText, connectAndLogin, describeIntegration, INTEGRATION_MODEL_ID, modelRequestInput, openSession, sendPrompt, stopAll} from "./integration-fixture";
import {execCommandResponse, startMockResponsesServer, textResponse} from "./mock-responses-server";
import {findPromptRequest} from "./model-request";

describeIntegration("integration: launch permission profiles", () => {
    it("applies session Git grants on warm hosts, load, resume and fork without losing protections", async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "codex-session-profiles-")));
        const git = (...args: string[]) => execFileSync("git", args, {stdio: "pipe"}).toString().trim();
        const mock = await startMockResponsesServer();
        let agent: SpawnedAgentFixture | undefined;
        try {
            const owners = ["primary", "secondary"].map(name => join(base, name));
            const filesystem: Record<string, "read" | "write" | "deny"> = {};
            const secret = join(base, "credential");
            writeFileSync(secret, "fixture-secret");
            filesystem[secret] = "deny";
            for (const owner of owners) {
                git("init", "-q", owner);
                git("-C", owner, "-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Fixture");
                git("clone", "--bare", "-q", owner, `${owner}-origin.git`);
                git("-C", owner, "remote", "add", "origin", `${owner}-origin.git`);
                const root = join(owner, ".git");
                filesystem[root] = "write";
                filesystem[`${root}/worktrees/**`] = "write";
                filesystem[join(root, "config")] = "read";
                filesystem[join(root, "hooks")] = "read";
            }
            const profiles = {
                "external-read-only": {extends: ":read-only", filesystem: {[secret]: "deny"}},
                "external-agent": {extends: ":workspace", filesystem},
                "external-full-access": {extends: ":workspace", filesystem},
            };
            const inline = (entries: Record<string, string>) => `{ ${Object.entries(entries).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(", ")} }`;
            agent = await createSpawnedAgentFixture(async () => {}, {
                [PERMISSION_PROFILE_CONFIG_ENV]: JSON.stringify({
                    configOverrides: [
                        'default_permissions="external-agent"',
                        ...Object.entries(profiles).flatMap(([id, profile]) => [
                            `permissions.${id}.extends=${JSON.stringify(profile.extends)}`,
                            `permissions.${id}.filesystem=${inline(profile.filesystem)}`,
                        ]),
                    ],
                    modeProfiles: {"read-only": "external-read-only", agent: "external-agent", "agent-full-access": "external-full-access"},
                }),
            });
            await connectAndLogin(agent, mock.baseUrl);
            const worktrees = (label: string) => owners.map(owner => {
                const cwd = `${owner}-${label}`;
                git("-C", owner, "worktree", "add", "-q", "-b", label, cwd);
                const admin = git("-C", cwd, "rev-parse", "--absolute-git-dir");
                mkdirSync(join(admin, "hooks"));
                writeFileSync(join(admin, "config"), "");
                writeFileSync(join(admin, "config.worktree"), "");
                return {cwd, admin, owner};
            });
            const metadata = (repos: ReturnType<typeof worktrees>) => {
                const permissionProfiles = structuredClone(profiles);
                for (const id of ["external-agent", "external-full-access"] as const) {
                    for (const {admin} of repos) {
                        permissionProfiles[id].filesystem[admin] = "write";
                        for (const name of ["hooks", "config", "config.worktree"]) permissionProfiles[id].filesystem[join(admin, name)] = "read";
                    }
                }
                return {codex: {permissionProfiles}};
            };
            const probe = async (label: string, sessionId: string, repos: ReturnType<typeof worktrees>, expectedFetch: number) => {
                await legacySetSessionModel(agent!.connection, {sessionId, modelId: INTEGRATION_MODEL_ID.toString()});
                const script = `const fs=require('node:fs'),cp=require('node:child_process');
const result=${JSON.stringify(repos)}.map(r=>{
const fetch=cp.spawnSync('git',['-C',r.cwd,'fetch','--no-tags','origin']).status;
const paths=[r.owner+'/.git/config',r.owner+'/.git/hooks/probe',r.admin+'/config',r.admin+'/config.worktree',r.admin+'/hooks/probe'];
const protectedWrites=paths.map(p=>{try{fs.appendFileSync(p,'');return false}catch{return true}});
return {fetch,protectedWrites};});
let secretDenied=false;try{fs.readFileSync(${JSON.stringify(secret)})}catch{secretDenied=true}
console.log(JSON.stringify({label:${JSON.stringify(label)},result,secretDenied}));`;
                const before = mock.requests.length;
                mock.setResponseHandler(body => {
                    if (!findPromptRequest([body], label)) {
                        return JSON.stringify(body).includes("Your task is to generate a very short title") ? textResponse("Fixture title") : undefined;
                    }
                    const output = (body as {input: Array<{type: string; call_id?: string}>}).input
                        .find(item => item.type === "function_call_output" && item.call_id === label);
                    return output ? textResponse(label) : execCommandResponse(label, {cmd: `node -e '${script.replaceAll("'", "'\\''")}'`});
                });
                expect((await sendPrompt(agent!, sessionId, label)).stopReason).toBe("end_turn");
                const output = mock.requests.slice(before).flatMap(body => (body as {input: Array<{type: string; call_id?: string; output?: string}>}).input)
                    .find(item => item.type === "function_call_output" && item.call_id === label);
                const line = String(output?.output).split("\n").find(value => value.startsWith('{"label":'));
                expect(line).toBeDefined();
                expect(JSON.parse(line!)).toEqual({label, secretDenied: true, result: repos.map(() => ({fetch: expectedFetch, protectedWrites: [true, true, true, true, true]}))});
            };
            const cold = worktrees("cold");
            const request = (repos: typeof cold) => ({cwd: repos[0]!.cwd, additionalDirectories: [repos[1]!.cwd], mcpServers: []});
            const initial = await agent.connection.request(acp.methods.agent.session.new, request(cold)) as acp.NewSessionResponse;
            await legacySetSessionModel(agent.connection, {sessionId: initial.sessionId, modelId: INTEGRATION_MODEL_ID.toString()});
            await probe("baseline", initial.sessionId, cold, 255);
            await agent.connection.request(acp.methods.agent.session.close, {sessionId: initial.sessionId});
            await agent.connection.request(acp.methods.agent.session.load, {...request(cold), sessionId: initial.sessionId, _meta: metadata(cold)});
            await probe("load-grants", initial.sessionId, cold, 0);

            const warm = worktrees("warm");
            const opened = await agent.connection.request(acp.methods.agent.session.new, {...request(warm), _meta: metadata(warm)});
            await legacySetSessionModel(agent.connection, {sessionId: opened.sessionId, modelId: INTEGRATION_MODEL_ID.toString()});
            await probe("warm-new", opened.sessionId, warm, 0);
            const unchanged = await agent.connection.request(acp.methods.agent.session.new, request(warm)) as acp.NewSessionResponse;
            await legacySetSessionModel(agent.connection, {sessionId: unchanged.sessionId, modelId: INTEGRATION_MODEL_ID.toString()});
            await probe("separate-thread", unchanged.sessionId, warm, 255);
            await agent.connection.request(acp.methods.agent.session.setMode, {sessionId: opened.sessionId, modeId: "agent-full-access"});
            await probe("warm-full-access", opened.sessionId, warm, 0);
            await agent.connection.request(acp.methods.agent.session.close, {sessionId: opened.sessionId});
            await agent.connection.request(acp.methods.agent.session.resume, {...request(warm), sessionId: opened.sessionId, _meta: metadata(warm)});
            await probe("warm-resume", opened.sessionId, warm, 0);
            const forked = await agent.connection.request(acp.methods.agent.session.fork, {...request(warm), sessionId: opened.sessionId, _meta: metadata(warm)});
            await probe("warm-fork", forked.sessionId, warm, 0);
            agent = await agent.restart();
            await connectAndLogin(agent, mock.baseUrl);
            await agent.connection.request(acp.methods.agent.session.load, {...request(warm), sessionId: opened.sessionId, _meta: metadata(warm)});
            await probe("restart-load", opened.sessionId, warm, 0);
            expect(mock.unexpectedRequests).toBe(0);
        } finally {
            await stopAll(agent, mock);
            rmSync(base, {recursive: true, force: true});
        }
    }, 120_000);

    it("retains launcher-owned network permissions through startup and a tool turn", async () => {
        const mock = await startMockResponsesServer();
        const network = createServer((_request, response) => response.end("profile-network-ok"));
        await new Promise<void>(resolve => network.listen(0, "127.0.0.1", resolve));
        const networkUrl = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;
        let agent: SpawnedAgentFixture | undefined;
        try {
            agent = await createSpawnedAgentFixture(async () => {}, {
                [PERMISSION_PROFILE_CONFIG_ENV]: JSON.stringify({
                    configOverrides: [
                        'default_permissions="external-agent"',
                        'permissions.external-read-only.extends=":read-only"',
                        'permissions.external-agent.extends=":workspace"',
                        'permissions.external-agent.network.enabled=true',
                        'permissions.external-full-access.extends=":workspace"',
                    ],
                    modeProfiles: {
                        "read-only": "external-read-only",
                        agent: "external-agent",
                        "agent-full-access": "external-full-access",
                    },
                }),
            });
            await connectAndLogin(agent, mock.baseUrl);
            const sessionId = await openSession(agent);
            mock.enqueue(execCommandResponse("profile-network", {
                cmd: `node -e 'fetch("${networkUrl}").then(r => r.text()).then(console.log)'`,
            }), textResponse("permission-profiles-ok"));

            expect((await sendPrompt(agent, sessionId, "check the network and say permission-profiles-ok")).stopReason).toBe("end_turn");
            expect(agentText(agent, sessionId)).toBe("permission-profiles-ok");
            const output = modelRequestInput(mock, 1).find(item => item.type === "function_call_output" && item.call_id === "profile-network");
            expect(JSON.stringify(output)).toContain("profile-network-ok");
            expect(mock.unexpectedRequests).toBe(0);
        } finally {
            await stopAll(agent, mock);
            network.closeAllConnections();
            await new Promise<void>(resolve => network.close(() => resolve()));
        }
    });
});
