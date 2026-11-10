import {describe, expect, it} from "vitest";
import {sessionPermissionProfiles, type PermissionProfileConfig} from "../PermissionProfileConfig";

const launcher: PermissionProfileConfig = {
    configOverrides: ['permissions.workspace.extends=":workspace"'],
    modeProfiles: {"read-only": "readonly", agent: "workspace", "agent-full-access": "full"},
};

describe("session permission profiles", () => {
    it.each([undefined, null, {}, {codex: null}, {codex: {permissionProfiles: null}}])("preserves existing metadata without profiles: %j", meta => {
        expect(sessionPermissionProfiles(meta, launcher)).toBeUndefined();
    });

    it.each([[], {unowned: {}}, {workspace: "write"}])("rejects malformed or unowned profile tables: %j", permissionProfiles => {
        expect(() => sessionPermissionProfiles({codex: {permissionProfiles}}, launcher)).toThrow();
    });

    it("requires launcher ownership and keeps the supplied native definition", () => {
        const permissionProfiles = {workspace: {extends: ":workspace", filesystem: {"/repo/.git/worktrees/task": "write", "/credentials": "deny"}}};
        const meta = {codex: {permissionProfiles}};
        expect(() => sessionPermissionProfiles(meta)).toThrow();
        expect(sessionPermissionProfiles(meta, launcher)).toEqual(permissionProfiles);
    });
});
