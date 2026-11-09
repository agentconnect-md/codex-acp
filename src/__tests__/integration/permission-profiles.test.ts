import {expect, it} from "vitest";
import {PERMISSION_PROFILE_CONFIG_ENV} from "../../PermissionProfileConfig";
import {createSpawnedAgentFixture, type SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {agentText, connectAndLogin, describeIntegration, openSession, sendPrompt, stopAll} from "./integration-fixture";
import {startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: launch permission profiles", () => {
    it("starts a session and completes a turn with launcher-owned profiles after gateway authentication", async () => {
        const mock = await startMockResponsesServer();
        let agent: SpawnedAgentFixture | undefined;
        try {
            agent = await createSpawnedAgentFixture(async () => {}, {
                [PERMISSION_PROFILE_CONFIG_ENV]: JSON.stringify({
                    configOverrides: [
                        'default_permissions="external-agent"',
                        'permissions.external-read-only.extends=":read-only"',
                        'permissions.external-agent.extends=":workspace"',
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
            mock.enqueue(textResponse("permission-profiles-ok"));

            expect((await sendPrompt(agent, sessionId, "say permission-profiles-ok")).stopReason).toBe("end_turn");
            expect(agentText(agent, sessionId)).toBe("permission-profiles-ok");
            expect(mock.unexpectedRequests).toBe(0);
        } finally {
            await stopAll(agent, mock);
        }
    });
});
