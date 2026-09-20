import {createHash, timingSafeEqual} from "node:crypto";
import {z} from "zod";

export const PERMISSION_PROFILE_CONFIG_ENV = "CODEX_ACP_PERMISSION_PROFILE_CONFIG";
/** Env entry a launcher-injected MCP server carries to prove the launcher, not session config, declared it. */
export const MCP_SERVER_CREDENTIAL_ENV = "CODEX_ACP_MCP_SERVER_CREDENTIAL";

const permissionProfileConfigSchema = z.object({
    configOverrides: z.array(z.string().min(1)).min(1),
    modeProfiles: z.object({
        "read-only": z.string().min(1),
        agent: z.string().min(1),
        "agent-full-access": z.string().min(1),
    }),
    // Servers the launcher injects itself and vouches for, each proven by a per-launch secret rather than by its name.
    trustedMcpServers: z.array(z.object({
        name: z.string().min(1),
        credential: z.string().min(1),
    })).optional(),
});

export type PermissionProfileConfig = z.infer<typeof permissionProfileConfigSchema>;

/**
 * Read an operator-owned, launch-wide permission profile mapping. The adapter
 * deliberately treats profile definitions as opaque Codex configuration: the
 * trusted launcher owns policy construction, while codex-acp only selects the
 * profile matching the active ACP mode.
 */
export function readPermissionProfileConfig(
    env: NodeJS.ProcessEnv = process.env,
): PermissionProfileConfig | undefined {
    const raw = env[PERMISSION_PROFILE_CONFIG_ENV];
    if (!raw) return undefined;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`${PERMISSION_PROFILE_CONFIG_ENV} must contain a JSON object`);
    }
    return permissionProfileConfigSchema.parse(parsed);
}

export function permissionProfileForMode(config: PermissionProfileConfig, modeId: string): string {
    const profile = config.modeProfiles[modeId as keyof PermissionProfileConfig["modeProfiles"]];
    if (!profile) throw new Error(`No permission profile configured for ACP mode ${modeId}`);
    return profile;
}

/**
 * True when a requested MCP server proves the launcher injected it: the launcher named the server
 * AND the server carries that entry's per-launch secret. A name alone is not proof, because session
 * config can declare a server under any name.
 */
export function hasTrustedMcpCredential(
    config: PermissionProfileConfig,
    name: string,
    env: unknown,
): boolean {
    const expected = config.trustedMcpServers?.find(entry => entry.name === name)?.credential;
    const presented = isRecord(env) ? env[MCP_SERVER_CREDENTIAL_ENV] : undefined;
    if (expected === undefined || typeof presented !== "string") return false;
    return timingSafeEqual(digest(expected), digest(presented));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hash both sides so the constant-time compare never leaks the secret's length. */
function digest(value: string): Buffer {
    return createHash("sha256").update(value, "utf8").digest();
}
