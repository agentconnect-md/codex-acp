import type {ModeKind} from "./app-server/ModeKind";
import type {ServiceTier} from "./app-server/ServiceTier";
import type {Model, Thread, ThreadItem} from "./app-server/v2";
import type {JsonValue} from "./app-server/serde_json/JsonValue";

export type PreparedSessionConfig = {
    config: {[key: string]: JsonValue | undefined};
    fullAccessApprovedMcpServers: string[];
};

export type SessionMetadata = {
    sessionId: string,
    currentModelId: string,
    models: Model[],
    collaborationMode: ModeKind,
    modelProvider?: string | null,
    currentServiceTier?: ServiceTier | null,
    additionalDirectories: string[],
    fullAccessApprovedMcpServers?: string[],
}

export type SessionMetadataWithThread = SessionMetadata & {
    /** The thread metadata. Its `turns` are empty: the items are in `history`. */
    thread: Thread,
    /** The items of the thread, oldest first, one page at a time. */
    history: AsyncIterable<ThreadItem[]>,
}
