// The mongosh shell tab (#396): sessions, the commands typed into them, and the
// per-tab state the app keeps in the backend so a shell survives remounts.
//
// Not a JavaScript interpreter. A session answers the few commands the specs
// type, from the in-memory servers, and reports any other name the way mongosh
// reports an undefined one. A command that calls `sleep(` never finishes on its
// own: it waits until its session is stopped, as a runaway script would.
import type { Backend, Handler } from '../backend';
import { guardWritable, isMock } from '../lookup';
import type { E2EState } from '../state';

interface Session {
  connectionId: string;
  database: string;
  /** Rejects the commands still running when the session is stopped. */
  pending: Array<(reason: string) => void>;
}

interface Output {
  stdout: string[];
  stderr: string[];
}

const printed = (...lines: string[]): Output => ({ stdout: lines, stderr: [] });
const failed = (message: string): Output => ({ stdout: [], stderr: [message] });

export function registerShellHandlers(backend: Backend, state: E2EState): void {
  const sessions = new Map<string, Session>();
  const tabStates = new Map<string, Record<string, unknown>>();
  let serial = 0;

  const databasesOf = (connectionId: string) => {
    const conn = state.connections[connectionId];
    if (!conn) throw 'Connection not found';
    return state.servers[conn.uri].databases;
  };

  /** What the backend checks before it runs mongosh: a read-only connection, then the sample server. */
  const checkConnection = (connectionId: unknown) => {
    guardWritable(state, connectionId);
    if (isMock(state, connectionId)) throw 'External mongosh sessions require a real MongoDB URI';
  };

  const requireBinary = (mongoshPath: unknown) => {
    if (!state.mongosh.available && !state.mongosh.binaries.includes(String(mongoshPath))) {
      throw 'Failed to start mongosh: program not found';
    }
  };

  const stop = (sessionId: unknown) => {
    const session = sessions.get(String(sessionId));
    if (!session) return;
    for (const reject of session.pending) reject('mongosh session closed');
    sessions.delete(String(sessionId));
  };

  /** One statement, as mongosh would answer it. */
  const evaluate = (session: Session, statement: string): Output | Promise<Output> => {
    const text = statement.trim().replace(/;$/, '');
    if (text === '') return printed();
    if (/\bsleep\(/.test(text)) return new Promise<Output>((_, reject) => session.pending.push(reject));

    const databases = databasesOf(session.connectionId);
    if (text === 'db') return printed(session.database);
    const use = text.match(/^use\s+([A-Za-z0-9_.-]+)$/);
    if (use) {
      session.database = use[1];
      return printed(`switched to db ${use[1]}`);
    }
    if (/^show\s+(dbs|databases)$/i.test(text)) return printed(...Object.keys(databases));
    if (/^show\s+(collections|tables)$/i.test(text)) return printed(...Object.keys(databases[session.database] ?? {}));

    const print = text.match(/^print\((["'])(.*)\1\)$/);
    if (print) return printed(print[2]);

    const call = text.match(/^db\.([A-Za-z_$][\w$]*)\.(find|findOne|countDocuments|count)\(\s*(\{\s*\})?\s*\)(?:\.limit\((\d+)\))?$/);
    if (call) {
      const docs = databases[session.database]?.[call[1]]?.docs ?? [];
      if (call[2] === 'countDocuments' || call[2] === 'count') return printed(String(docs.length));
      const limit = call[2] === 'findOne' ? 1 : Number(call[4] ?? 20);
      return printed(...docs.slice(0, limit).map((doc) => JSON.stringify(doc)));
    }
    if (/^db\./.test(text)) return failed(`e2e fake mongosh does not run "${text}"`);

    const name = text.match(/^[A-Za-z_$][\w$]*/)?.[0] ?? text;
    return failed(`ReferenceError: ${name} is not defined`);
  };

  const handlers: Record<string, Handler> = {
    start_mongosh_session: ({ connectionId, database, mongoshPath }) => {
      databasesOf(String(connectionId));
      checkConnection(connectionId);
      requireBinary(mongoshPath);
      serial += 1;
      const id = `mongosh-${serial}`;
      sessions.set(id, { connectionId: String(connectionId), database: String(database), pending: [] });
      return { session_id: id, stdout: [], stderr: [] };
    },
    run_mongosh_command: ({ sessionId, command }) => {
      const session = sessions.get(String(sessionId));
      if (!session) throw 'mongosh session not found';
      return evaluate(session, String(command));
    },
    // A multi-line script runs once, outside the session, against the tab's database.
    run_mongosh_script: async ({ connectionId, database, mongoshPath, script }) => {
      databasesOf(String(connectionId));
      checkConnection(connectionId);
      requireBinary(mongoshPath);
      const once: Session = { connectionId: String(connectionId), database: String(database), pending: [] };
      const output: Output = { stdout: [], stderr: [] };
      for (const line of String(script).split('\n')) {
        const result = await evaluate(once, line);
        output.stdout.push(...result.stdout);
        output.stderr.push(...result.stderr);
      }
      return output;
    },
    stop_mongosh_session: ({ sessionId }) => {
      stop(sessionId);
      return null;
    },
    await_mongosh_idle: () => null,
    detect_mongosh_binary: () => structuredClone(state.mongosh.detection),

    // Per-tab shell state, kept by the backend so a remounted tab reattaches.
    set_shell_tab_state: ({ tabId, value }) => {
      tabStates.set(String(tabId), structuredClone(value as Record<string, unknown>));
      return null;
    },
    claim_shell_tab_state: ({ tabId }) => structuredClone(tabStates.get(String(tabId)) ?? null),
    disown_shell_tab_state: () => null,
    close_shell_tab_session: ({ tabId }) => {
      stop(tabStates.get(String(tabId))?.sessionId);
      tabStates.delete(String(tabId));
      return null;
    },
    rename_shell_tab_state: ({ oldId, newId }) => {
      const value = tabStates.get(String(oldId));
      if (value) {
        tabStates.set(String(newId), value);
        tabStates.delete(String(oldId));
      }
      return null;
    },
    clear_all_shell_tab_state: () => {
      for (const value of tabStates.values()) stop(value.sessionId);
      tabStates.clear();
      return null;
    },
  };

  backend.register(handlers);
}
