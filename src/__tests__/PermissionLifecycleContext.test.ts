import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import type {SessionState} from "../CodexAcpServer";
import {CodexElicitationHandler} from "../CodexElicitationHandler";
import type {AcpClientConnection} from "../ACPSessionConnection";
import type {ServerNotification} from "../app-server";
import {PermissionLifecycleContext} from "../permissions/lifecycle";
import {CodexApprovalHandler} from "../permissions/CodexApprovalHandler";

function sessionState(): SessionState {
    return {
        sessionId: "session",
        currentTurnId: "turn-1",
    } as SessionState;
}

function mcpStarted(id: string, turnId: string, threadId = "thread"): ServerNotification {
    return {
        method: "item/started",
        params: {
            threadId,
            turnId,
            startedAtMs: 0,
            item: {
                type: "mcpToolCall",
                id,
                server: "server",
                tool: "tool",
                status: "inProgress",
                arguments: {},
                appContext: null,
                mcpAppUi: null,
                readOnlyHint: null,
                pluginId: null,
                result: null,
                error: null,
                durationMs: null,
            },
        },
    };
}

function fileChangeStarted(id: string, threadId: string): ServerNotification {
    return {
        method: "item/started",
        params: {
            threadId,
            turnId: `turn-${threadId}`,
            startedAtMs: 0,
            item: {
                type: "fileChange",
                id,
                changes: [{path: `/${threadId}.txt`, kind: {type: "add"}, diff: "+content"}],
                status: "inProgress",
            },
        },
    };
}

function commandStarted(id: string, threadId: string): Extract<ServerNotification, {method: "item/started"}> {
    return {
        method: "item/started",
        params: {
            threadId,
            turnId: `turn-${threadId}`,
            startedAtMs: 0,
            item: {
                type: "commandExecution",
                id,
                pluginId: null,
                scriptPath: null,
                command: "npm test",
                cwd: "/workspace",
                processId: null,
                source: "unifiedExecStartup",
                status: "inProgress",
                commandActions: [],
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
            },
        },
    };
}

function turnCompleted(threadId: string): ServerNotification {
    return {
        method: "turn/completed",
        params: {
            threadId,
            turn: {
                id: `turn-${threadId}`,
                items: [],
                itemsView: "full",
                status: "completed",
                error: null,
                startedAt: 0,
                completedAt: 1,
                durationMs: 1_000,
            },
        },
    };
}

describe("PermissionLifecycleContext", () => {
    it("clears MCP correlation at the turn boundary", () => {
        const lifecycle = new PermissionLifecycleContext(sessionState());
        const prompt = lifecycle.beginPrompt();
        prompt.handleNotification(mcpStarted("stale-call", "turn-1"));
        prompt.handleNotification({
            method: "turn/completed",
            params: {
                threadId: "thread",
                turn: {
                    id: "turn-1",
                    items: [],
                    itemsView: "full",
                    status: "completed",
                    error: null,
                    startedAt: 0,
                    completedAt: 1,
                    durationMs: 1_000,
                },
            },
        });
        prompt.handleNotification(mcpStarted("current-call", "turn-2"));

        expect(prompt.popPendingMcpApproval("thread", "server")).toBe("current-call");
    });

    it("keeps synthetic IDs session-scoped across prompt contexts", () => {
        const lifecycle = new PermissionLifecycleContext(sessionState());
        expect(lifecycle.beginPrompt().nextStandaloneMcpToolCallId("server"))
            .toBe("elicitation:session:server:1");
        expect(lifecycle.beginPrompt().nextStandaloneMcpToolCallId("server"))
            .toBe("elicitation:session:server:2");
    });

    it("isolates MCP correlation between prompt generations", () => {
        const lifecycle = new PermissionLifecycleContext(sessionState());
        const stalePrompt = lifecycle.beginPrompt();
        const currentPrompt = lifecycle.beginPrompt();
        currentPrompt.handleNotification(mcpStarted("current-call", "turn-2"));

        expect(stalePrompt.popPendingMcpApproval("thread", "server")).toBeUndefined();
        expect(currentPrompt.popPendingMcpApproval("thread", "server")).toBe("current-call");
    });

    it("clears only the completed thread's permission correlation", () => {
        const prompt = new PermissionLifecycleContext(sessionState()).beginPrompt();
        prompt.handleNotification(mcpStarted("call-a", "turn-a", "child-a"));
        prompt.handleNotification(mcpStarted("call-b", "turn-b", "child-b"));
        prompt.handleNotification(fileChangeStarted("shared-file-change", "child-a"));
        prompt.handleNotification(fileChangeStarted("shared-file-change", "child-b"));
        prompt.handleNotification(commandStarted("shared-command", "child-a"));
        prompt.handleNotification(commandStarted("shared-command", "child-b"));

        prompt.handleNotification(turnCompleted("child-b"));

        expect(prompt.popPendingMcpApproval("child-a", "server")).toBe("call-a");
        expect(prompt.popPendingMcpApproval("child-b", "server")).toBeUndefined();
        expect(prompt.fileChange("child-a", "shared-file-change")?.changes[0]?.path).toBe("/child-a.txt");
        expect(prompt.fileChange("child-b", "shared-file-change")).toBeUndefined();
        expect(prompt.commandName("child-a", "shared-command")).toBe("exec_command");
        expect(prompt.commandName("child-b", "shared-command")).toBeUndefined();
    });

    it("clears a completed command's name", () => {
        const prompt = new PermissionLifecycleContext(sessionState()).beginPrompt();
        const notification = commandStarted("command", "thread");
        prompt.handleNotification(notification);
        expect(prompt.commandName("thread", "command")).toBe("exec_command");

        prompt.handleNotification({
            method: "item/completed",
            params: {
                threadId: notification.params.threadId,
                turnId: notification.params.turnId,
                completedAtMs: 1,
                item: notification.params.item,
            },
        });

        expect(prompt.commandName("thread", "command")).toBeUndefined();
    });

    it("does not allocate a synthetic ID for native ACP elicitation", async () => {
        const state = sessionState();
        const lifecycle = new PermissionLifecycleContext(state);
        const prompt = lifecycle.beginPrompt();
        const connection = {
            request: vi.fn().mockResolvedValue({action: "decline"}),
        } as unknown as AcpClientConnection;
        const handler = new CodexElicitationHandler(
            connection,
            prompt,
            {elicitation: {form: {}}},
        );

        await handler.handleElicitation({
            threadId: "thread",
            turnId: "turn-1",
            serverName: "server",
            mode: "form",
            _meta: null,
            message: "Collect a value",
            requestedSchema: {type: "object", properties: {value: {type: "string"}}},
        });

        expect(prompt.nextStandaloneMcpToolCallId("server")).toBe("elicitation:session:server:1");
    });

    it("does not allocate a synthetic ID for a correlated permission fallback", async () => {
        const state = sessionState();
        const prompt = new PermissionLifecycleContext(state).beginPrompt();
        const requests: Array<{toolCall: {toolCallId: string}}> = [];
        const connection = {
            request: vi.fn().mockImplementation((_method, request) => {
                requests.push(request);
                return Promise.resolve({outcome: {outcome: "selected", optionId: "cancel"}});
            }),
            notify: vi.fn(),
        } as unknown as AcpClientConnection;
        const handler = new CodexElicitationHandler(connection, prompt);
        const approval = {
            threadId: "thread",
            turnId: "turn-1",
            serverName: "server",
            mode: "form" as const,
            _meta: {codex_approval_kind: "mcp_tool_call"},
            message: "Allow?",
            requestedSchema: {type: "object" as const, properties: {}},
        };

        prompt.handleNotification(mcpStarted("correlated-call", "turn-1"));
        await handler.handleElicitation(approval);
        await handler.handleElicitation(approval);

        expect(requests.map(request => request.toolCall.toolCallId)).toEqual([
            "correlated-call",
            "elicitation:session:server:1",
        ]);
    });

    it("autoapproves only launcher-approved servers and restores client approval on a mode change", async () => {
        let approvedServers: ReadonlySet<string> | undefined = new Set(["server"]);
        const request = vi.fn().mockResolvedValue({outcome: {outcome: "selected", optionId: "allow_once"}});
        const notify = vi.fn();
        const cancellation = new AbortController();
        const prompt = new PermissionLifecycleContext(sessionState()).beginPrompt();
        const handler = new CodexElicitationHandler(
            {request, notify} as unknown as AcpClientConnection,
            prompt, null, cancellation.signal, () => approvedServers,
        );
        const approval = {
            threadId: "thread", turnId: "turn-1", serverName: "server", mode: "form" as const,
            _meta: {codex_approval_kind: "mcp_tool_call", persist: "session"},
            message: "Allow?", requestedSchema: {type: "object" as const, properties: {}},
        };
        prompt.handleNotification(mcpStarted("call", "turn-1"));
        expect(await handler.handleElicitation(approval)).toEqual({action: "accept", content: {}, _meta: null});
        expect(notify).toHaveBeenCalledWith(acp.methods.client.session.update, {
            sessionId: "thread", update: {sessionUpdate: "tool_call_update", toolCallId: "call", status: "in_progress"},
        });
        for (const rejected of [
            {...approval, serverName: "unlisted"},
            {...approval, _meta: {codex_approval_kind: "mcp_tool_call"}},
            {...approval, _meta: null},
            {...approval, requestedSchema: {type: "object" as const, properties: {value: {type: "string" as const}}}},
        ]) {
            expect(await handler.handleElicitation(rejected)).toEqual({action: "cancel", content: null, _meta: null});
        }
        expect(request).not.toHaveBeenCalled();
        approvedServers = undefined;
        expect(await handler.handleElicitation(approval)).toEqual({action: "accept", content: null, _meta: null});
        expect(request).toHaveBeenCalledTimes(1);
        approvedServers = new Set(["server"]);
        expect(await handler.handleElicitation(approval)).toEqual({action: "accept", content: {}, _meta: null});
        cancellation.abort();
        expect(await handler.handleElicitation(approval)).toEqual({action: "cancel", content: null, _meta: null});
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("keeps Full access permission refusals without blocking ordinary questions", async () => {
        let fullAccess = true;
        const request = vi.fn().mockResolvedValue({action: "accept", content: {choice: "Proceed"}});
        const connection = {request} as unknown as AcpClientConnection;
        const prompt = new PermissionLifecycleContext(sessionState()).beginPrompt();
        const elicitation = new CodexElicitationHandler(
            connection, prompt, {elicitation: {form: {}}}, undefined,
            () => fullAccess ? new Set(["server"]) : undefined,
        );
        const approvals = new CodexApprovalHandler(connection, prompt, undefined, () => fullAccess);
        const input = {
            threadId: "thread", turnId: "turn-1", itemId: "mcp-deps-turn-1", isBlocking: true, autoResolutionMs: null,
            questions: [{id: "skill_mcp_dependency_install", header: "Install", question: "Install MCP dependency?",
                isOther: false, isSecret: false, options: null}],
        };
        expect(await elicitation.handleUserInput(input)).toEqual({answers: {}});
        const network = {
            kind: "command" as const, threadId: "thread", turnId: "turn-1", itemId: "network", startedAtMs: 0,
            environmentId: null, networkApprovalContext: {host: "example.test", protocol: "https" as const},
        };
        expect(await approvals.handleCommandExecution(network)).toEqual({decision: "cancel"});
        expect(await approvals.handlePermissionsRequest({
            threadId: "thread", turnId: "turn-1", itemId: "permissions", startedAtMs: 0,
            environmentId: null, cwd: "/workspace", reason: null, permissions: {network: {enabled: true}, fileSystem: null},
        })).toEqual({permissions: {}, scope: "turn", strictAutoReview: false});
        expect(request).not.toHaveBeenCalled();

        for (fullAccess of [true, false]) {
            expect(await elicitation.handleUserInput({
                ...input, itemId: "question", questions: [{...input.questions[0]!, id: "choice"}],
            })).toEqual({answers: {choice: {answers: ["Proceed"]}}});
        }
        request.mockResolvedValueOnce({outcome: {outcome: "selected", optionId: "allow_once"}});
        expect(await approvals.handleCommandExecution(network)).toEqual({decision: "accept"});
        expect(request).toHaveBeenCalledTimes(3);
    });
});
