/**
 * The DJ Opus session an MCP session drives. The tools of the generic MCP (src/remote-mcp/tools.ts) read it on every
 * call, make one the first time there is none, and connect rebinds it to a session that is already open.
 */
export interface SessionBinding {
  /** The session id that is bound, or null when there is none yet. */
  get(): Promise<string | null>;
  /** Binds `id`, in place of the one before. The caller has checked that it is a session id. */
  set(id: string): Promise<void>;
}

/** The storage key of the binding. The agent's own keys (initializeRequest, props, cf_agents:*) are other names. */
export const SESSION_BINDING_KEY = 'djSessionId';

/**
 * The binding kept in the storage of the MCP session's own Durable Object (src/remote-mcp/agent.ts), so it lasts as
 * long as the MCP session does, evictions included.
 */
export function storageBinding(storage: DurableObjectStorage): SessionBinding {
  return {
    async get() {
      const id = await storage.get<unknown>(SESSION_BINDING_KEY);
      return typeof id === 'string' ? id : null;
    },
    async set(id) {
      await storage.put(SESSION_BINDING_KEY, id);
    },
  };
}
