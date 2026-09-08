import type {ModeKind} from "./app-server/ModeKind";
import type {ServiceTier} from "./app-server/ServiceTier";
import type {Model, Thread} from "./app-server/v2";
import type {JsonValue} from "./app-server/serde_json/JsonValue";

export type PreparedSessionConfig = {
    config: {[key: string]: JsonValue | undefined};
    fullAccessHttpMcpServers: string[];
};

export type SessionMetadata = {
    sessionId: string,
    currentModelId: string,
    models: Model[],
    collaborationMode: ModeKind,
    modelProvider?: string | null,
    currentServiceTier?: ServiceTier | null,
    additionalDirectories: string[],
    fullAccessHttpMcpServers?: string[],
}

export type SessionMetadataWithThread = SessionMetadata & {
    thread: Thread,
}
