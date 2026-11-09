import {expect, it} from "vitest";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {PERMISSION_PROFILE_CONFIG_ENV} from "../../PermissionProfileConfig";
import {createSpawnedAgentFixture, type SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {agentText, connectAndLogin, describeIntegration, modelRequestInput, openSession, sendPrompt, stopAll} from "./integration-fixture";
import {execCommandResponse, startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: launch permission profiles", () => {
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
