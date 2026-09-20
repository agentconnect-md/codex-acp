import {describe, expect, it} from "vitest";
import {
    hasTrustedMcpCredential,
    MCP_SERVER_CREDENTIAL_ENV,
    PERMISSION_PROFILE_CONFIG_ENV,
    readPermissionProfileConfig,
    type PermissionProfileConfig,
} from "../PermissionProfileConfig";

const BASE: PermissionProfileConfig = {
    configOverrides: ["permissions.external-agent.extends=\":workspace\""],
    modeProfiles: {
        "read-only": "external-read-only",
        agent: "external-agent",
        "agent-full-access": "external-full-access",
    },
};

const VOUCHED: PermissionProfileConfig = {
    ...BASE,
    trustedMcpServers: [{name: "bridge", credential: "launch-secret"}],
};

describe("trusted MCP server credentials", () => {
    it("reads launcher-vouched servers from the profile environment", () => {
        const raw = JSON.stringify(VOUCHED);
        const config = readPermissionProfileConfig({[PERMISSION_PROFILE_CONFIG_ENV]: raw});

        expect(config?.trustedMcpServers).toEqual([{name: "bridge", credential: "launch-secret"}]);
        // The field stays optional so an older launcher keeps working.
        expect(readPermissionProfileConfig({
            [PERMISSION_PROFILE_CONFIG_ENV]: JSON.stringify(BASE),
        })?.trustedMcpServers).toBeUndefined();
    });

    it("vouches for a server only when the name and the secret both match", () => {
        expect(hasTrustedMcpCredential(VOUCHED, "bridge", {
            [MCP_SERVER_CREDENTIAL_ENV]: "launch-secret",
            AC_MCP_TOKEN: "unrelated",
        })).toBe(true);

        // A name alone is not proof: session config can declare a server under any name.
        expect(hasTrustedMcpCredential(VOUCHED, "bridge", {})).toBe(false);
        expect(hasTrustedMcpCredential(VOUCHED, "bridge", {[MCP_SERVER_CREDENTIAL_ENV]: "guessed"})).toBe(false);
        expect(hasTrustedMcpCredential(VOUCHED, "bridge", {[MCP_SERVER_CREDENTIAL_ENV]: "launch-secre"})).toBe(false);
        // A valid secret presented under a name the launcher never vouched for is still refused.
        expect(hasTrustedMcpCredential(VOUCHED, "impostor", {[MCP_SERVER_CREDENTIAL_ENV]: "launch-secret"})).toBe(false);
    });

    it("refuses every server when the launcher vouched for none", () => {
        expect(hasTrustedMcpCredential(BASE, "bridge", {[MCP_SERVER_CREDENTIAL_ENV]: "launch-secret"})).toBe(false);
    });

    it("tolerates a server with no environment at all", () => {
        for (const env of [undefined, null, "env", ["env"], {[MCP_SERVER_CREDENTIAL_ENV]: 7}]) {
            expect(hasTrustedMcpCredential(VOUCHED, "bridge", env)).toBe(false);
        }
    });
});
