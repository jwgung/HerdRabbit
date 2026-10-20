// A synthetic OpenCode database: the schema of OpenCode's opencode.db (the
// tables the chat reads, and the ones holding secrets it must never read),
// filled with made-up rows. Nothing here comes from a real conversation.
import { DatabaseSync } from "node:sqlite";

export const OPENCODE_SCHEMA = `
CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL, url text NOT NULL, access_token text NOT NULL,
  refresh_token text NOT NULL, token_expiry integer, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL,
  connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text);
CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, vcs text, name text, time_created integer NOT NULL,
  time_updated integer NOT NULL, sandboxes text NOT NULL, commands text);
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL,
  directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer,
  summary_deletions integer, summary_files integer, summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text,
  agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL,
  time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE todo (session_id text NOT NULL, content text NOT NULL, status text NOT NULL, priority text NOT NULL,
  position integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, PRIMARY KEY(session_id, position));
CREATE TABLE session_share (session_id text PRIMARY KEY, id text NOT NULL, secret text NOT NULL, url text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
CREATE INDEX part_message_id_id_idx ON part (message_id, id);
CREATE INDEX part_session_idx ON part (session_id);
CREATE INDEX session_parent_idx ON session (parent_id);
`;

// Ids that sort as OpenCode's ascending ids do.
const pad = (n) => String(n).padStart(8, "0");
export const messageId = (n) => `msg_${pad(n)}AAAAAAAAAAAAAAAAAA`;
export const partId = (n) => `prt_${pad(n)}AAAAAAAAAAAAAAAAAA`;

export function opencodeDb(path, { schema = OPENCODE_SCHEMA } = {}) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(schema);
  db.exec("INSERT INTO project VALUES ('prj_1', '/work', 'git', 'work', 1, 1, '[]', NULL)");
  db.exec("INSERT INTO account VALUES ('acc_1', 'a@example.invalid', 'https://example.invalid', 'SECRET-ACCESS', 'SECRET-REFRESH', NULL, 1, 1)");
  let nextMessage = 1;
  let nextPart = 1;
  let clock = Date.UTC(2026, 9, 1, 9, 0, 0);
  const tick = (ms = 1000) => (clock += ms);
  const bump = (session) => {
    db.prepare("INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, 1) ON CONFLICT(aggregate_id) DO UPDATE SET seq = seq + 1").run(session);
    db.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(clock, session);
  };
  return {
    db,
    close: () => db.close(),
    session(id, { directory = "/work/app", parent = null, archived = null, revert = null, version = "1.0.0" } = {}) {
      const time = tick();
      db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived, revert)
        VALUES (?, 'prj_1', ?, 'slug', ?, 'title', ?, ?, ?, ?, ?)`).run(id, parent, directory, version, time, time, archived, revert);
      db.prepare("INSERT INTO session_share VALUES (?, 'shr_1', 'SECRET-SHARE', 'https://example.invalid/s', 1, 1)").run(id);
      bump(id);
      return id;
    },
    // A message and its parts; `info` is the message's data, parts are part datas.
    message(session, info, parts = []) {
      const id = messageId(nextMessage++);
      const time = tick();
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(id, session, time, time,
        JSON.stringify({ time: { created: time, ...(info.role === "assistant" ? { completed: time + 500 } : {}) }, ...info }));
      for (const data of parts) this.part(session, id, data);
      bump(session);
      return id;
    },
    part(session, message, data) {
      const id = partId(nextPart++);
      const time = tick(10);
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(id, message, session, time, time, JSON.stringify(data));
      bump(session);
      return id;
    },
    updatePart(session, id, data) {
      const time = tick(10);
      db.prepare("UPDATE part SET data = ?, time_updated = ? WHERE id = ?").run(JSON.stringify(data), time, id);
      bump(session);
    },
    revert(session, message) {
      db.prepare("UPDATE session SET revert = ? WHERE id = ?").run(message === null ? null : JSON.stringify({ messageID: message }), session);
      tick();
      bump(session);
    },
    // A prompt and its answer: the user's words, then text (and any parts) from the agent.
    exchange(session, n, extra = []) {
      this.message(session, { role: "user", agent: "build", model: { providerID: "test", modelID: "model-test" } },
        [{ type: "text", text: `prompt ${n}` }]);
      return this.message(session, { role: "assistant", modelID: "model-test", providerID: "test", mode: "build",
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 50, write: 5 } }, cost: 0 },
      [{ type: "step-start" }, ...extra, { type: "text", text: `answer ${n}` }, { type: "step-finish", reason: "stop" }]);
    },
  };
}
