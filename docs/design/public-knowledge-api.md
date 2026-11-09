# Public knowledge API

A read-only HTTP API that lets teammates search and read this host's shared knowledge
over an authenticating tunnel, without reaching anything else Standup serves. It is a separate Hono app
(`packages/collector/src/public-knowledge/app.ts`) on its own Unix socket; the collector's own
routes are never mounted on it, and its routes are never mounted on the collector's port.

## Identity and trust

The caller is the header named by `STANDUP_PUBLIC_KB_IDENTITY_HEADER` (`publicIdentityHeader()` in
`public-knowledge/identity.ts`) and nothing else. The relay in front of the socket must strip any
client-supplied copy of that header and stamp the alias it authenticated, and enforce its own allow
list before a request reaches this host; the relay's own credentials never reach the origin. The
setting has no default, and neither `STANDUP_IDENTITY_HEADER` nor the tunnel provider's
`STANDUP_TUNNEL_IDENTITY_HEADER` stands in for it: a header the relay does not stamp is one a
caller can set, so the owner names the relay's header explicitly.

While the setting is unset or isn't a header name (letters, digits and `-`, at most 64), the
listener refuses to bind and logs `[public-kb] Not listening: …`, and the app answers every request
with 503 `{"error":"not configured"}` (`PUBLIC_KB_NOT_CONFIGURED`). The owner routes report the
reason in `error`.

Owner tokens, `x-standup-*` headers and cookies are never read, so the owner secret grants nothing
here: a request with the owner token and no relay header is 401, and with a non-allowlisted alias
is 403.

**The listener is a 0700 Unix socket, never TCP.** It is at `<dataDir>/public/kb.sock`, or
`STANDUP_PUBLIC_KB_SOCKET`. The default directory is created 0700 (and tightened if it already
exists); a directory `STANDUP_PUBLIC_KB_SOCKET` names is checked but never changed, and the listener
refuses to start if that directory is not owned by this user or is group/world accessible. The
socket itself is 0600. A socket file already at the path is removed only when nothing answers a
connection on it; if a live process does (another collector), this one does not start, so a scratch
collector can neither take over nor delete the live socket. Request bodies are capped at 16 KB.

**What a same-uid process can do.** Any process running as the host user (the collector's workers
included) can connect to the socket and put any alias in the header. That gets it only what the API
serves: shareable knowledge, which the same process can already search through Standup's own API
and read straight from `standup.db`. That is the real boundary: a same-uid process is
owner-equivalent, and the socket only ever hands it knowledge that is shareable anyway.

On top of that, the safety floor holds a worker's connection to the configured socket path as
`standup-ops`, like a call to the collector's port, wherever the path is — the default under the
data dir or a `STANDUP_PUBLIC_KB_SOCKET` outside it: `curl --unix-socket`, `socat UNIX-CONNECT:`,
`nc -U`, and any command or code that names the path (runs of slashes collapsed, string literals
joined across `+`); a glob given as a socket operand whose directory part can match the socket's
directory (`--unix-socket /tmp/kb/kb.s*`); any command or code that reads
`STANDUP_PUBLIC_KB_SOCKET` (`$VAR`, `${VAR}`, `printenv VAR`, `os.environ["VAR"]`, `getenv("VAR")`,
`process.env.VAR` and the like) — an assignment, a commit message, a search pattern or any other mere
mention of the name is not a read; and code given to an interpreter (`-c`, `-e`, a
heredoc) that names both the socket's file name and its directory's name
(`os.path.join("/tmp", "kb", "kb.sock")`). A path built at run time is undecidable in general, so
this is best-effort: it catches the ordinary spellings, not a determined same-uid process. Nothing
is reachable over TCP, so no other host can forge the header.

## Access

An alias is admitted when the allowlist names it, or when `id -Gn <alias>` lists one of the
allowlist's POSIX groups. `id -Gn` includes each user's primary group, so allowing a broad group
(a department's default group) lets in everyone in it. The group lookup runs without a shell and
times out after 2s. An answered lookup (groups found, or the alias unknown) is cached for 5 minutes;
a failed one (timeout, spawn failure) admits nothing and is retried after 10s. The cache holds at
most 1000 aliases, evicting the least recently used.

Aliases are case-insensitive: the caller's alias is lowercased as it is read, and so are allowlist
entries as they are stored, so the allowlist check and the call log both key on one spelling.

The allowlist is the `publicKnowledgeAccess` setting, `{aliases, posixGroups}`. Until the owner sets
it, it is the host user alone. A stored value that fails to parse admits no one. `PUT /api/settings`
cannot write it; only the owner routes below can.

## Endpoints

All under `/api/public/knowledge/v1`. Anything else answers 404 `{"error":"not found"}`, including
encoded traversal (`/v1/%2e%2e/%2e%2e/settings`) and other versions.

| Route | Answer |
| --- | --- |
| `GET /whoami` | `{alias}` |
| `GET /search?q=&project=&limit=` | `{hits:[{slug,project,title,excerpt,score,verdict?}]}`. `q` is required (400); `limit` defaults to 10, at most 50. Without `project`, every shareable project plus the global corpus. `verdict` is `"contradicted"` on a doc flagged as contradicting another. |
| `GET /projects` | `{projects:[{id,name,docCount}]}` — shareable projects and the global corpus |
| `GET /projects/:project/docs` | `{docs:[{slug,title,kind,updatedAt}]}`; 404 for an unknown or withheld project |
| `GET /docs/:project/:slug` | `{slug,project,title,body,kind,scope,tags,updatedAt,…}`; a withheld doc is 404 with the same body as a missing one. `related` lists only the entries that resolve to a doc this API serves. |
| `POST /ask` | **410 Gone**, always (after the identity check): `{error:"gone", message, search:"/api/public/knowledge/v1/search"}`. The API synthesizes no answers; ask with `GET /search?q=<question>` and open a hit with `GET /docs/:project/:slug`. |

**Every text the API returns is redacted at the full tier** — titles, bodies, tags, project names
and excerpts go through `redactSecrets(…, {tier: "full"})`: provider tokens,
credential-shaped assignments and AWS account ids in account context, whatever tier the doc was
written under. This covers project docs (written under the signature tier) and hand-edited files
that never passed a write path. Search excerpts are cut from the doc's redacted body, so a secret an
excerpt's edge would split is redacted whole first: a lexical match is cut around the query's terms
(`extractExcerpt`); an embedding-only match is the lines of the redacted body its matched chunk spans,
placed by a chunk line the redaction leaves unchanged. `/docs` bodies are served as written: a served
doc that names another doc in its prose is the owner's shared content.

## Ranking

Every observable public output — which docs `/search` returns, and their order and `score` — is a
function of the **served corpus** (shareable and trusted docs) and the query alone. The backend's own search can't promise that: FTS5's bm25 takes its idf and average
length over the whole index, withheld projects and personal docs included, and its candidate windows
are cut by that score. A private doc containing a query word would move a shared doc's score, push
it out of a window, or carry it across the relevance floor, and so tell a caller something about
docs it can't read. Public reads therefore never call the backend's search; they go through
`publicRetrieval`:

- **Membership is boolean.** Each query phrase (`queryPhrases`, the phrases the main search matches
  on) is matched through FTS5 with no ranking and no limit, and the matches are intersected with the
  served corpus in memory, so a withheld doc never takes a candidate slot. Past 500 matches the most
  recently updated are kept, an order no statistic decides.
- **Scores are BM25 over the served corpus.** N, each phrase's document frequency and the average
  length (title plus body, in characters) are counted over the served corpus only; term frequency
  and length come from the doc's own text (k1 1.2, b 0.75, as FTS5). The relevance the confidence
  floors read is the shared formula (`relevanceSignals` / `relevanceOf`) over those numbers, and
  `score` is that relevance times the doc's own trust multiplier (verdict, confidence, age). Hits
  are ordered by `score`, then relevance, then id.
- **The semantic arm**, when the host embeds, scores every chunk of every served doc by cosine (a
  number with no corpus statistics) against the fixed default cosine band, never the band
  calibrated over the whole index; a doc whose best chunk clears the band's low end is a candidate.
- **A contradicted doc** is judged only against the served docs it contradicts.

The cost per query is one scan of the knowledge table's metadata (no bodies), one unranked FTS
lookup per query phrase (at most 24), a read of the candidates' bodies and chunk counts, and — with
embeddings — a brute-force cosine over every chunk of the served corpus. Public reads add no
retrieval telemetry.

Every request is logged to `public_kb_calls` (alias, `METHOD path`, status, and the search text or
`project/slug`). Control characters (C0, C1), bidi controls and marks (U+202A–202E,
U+2066–2069, U+200E/200F, U+061C), zero-width characters (U+200B–200D, U+2060, U+FEFF) and the
line/paragraph separators (U+2028/2029) are replaced with U+FFFD before a field is cut to 200
characters, and a high surrogate the cut leaves unpaired is dropped. Every non-2xx answer (400, 401,
403, 404, 410, 500, 503) is throttled: in each minute the first 20 per alias and 200 in all get
a row each; the rest are counted, one `refused calls (collapsed)` row per alias, when the minute
closes. `/whoami` rows are capped the same way at 5 per alias a minute (`whoami calls (collapsed)`),
and every other answered (2xx) call at 60 per alias and 600 in all a minute (`answered calls
(collapsed)`), so neither refusals nor a busy caller can flush the log's other rows out.
The log keeps its newest 5000 rows. **The log is advisory**: any same-uid process can connect and
write rows under any alias. A tunnel service may keep its own access log, which can show full query strings.

## What is shareable

A doc is served only when it is homed in the reserved global corpus or a project whose `shareable`
flag is on (the default), and it is none of:

- scope `user` (personal), or anything `layerOf` puts in the personal or activity layer;
- a Persona memory (`persona-*`);
- a native-memory mirror (`native-mem-*`: CLAUDE.md, rules, auto-memory notes).

A scope `global` doc homed in a withheld project stays withheld, and a reference whose scope is not
known (a bare `project/slug`) is not shareable until resolved to its doc. Retrieval draws only from
docs `isPubliclyShareable` admits (see Ranking), narrowed to the named project when one is given.

Every route also applies a trust gate (`isPubliclyTrusted`), the origin and verdict halves of the
injection gate: a doc of untrusted or unknown origin, or one re-verification marked disputed or
superseded, is not served. A doc flagged as contradicting another is served on both sides of the
pair, labeled with its `verdict`; which side wins is a per-query judgment, not a property of the doc.

New projects are shared by default; the owner unticks a project in the console to withhold it.

`projects.shareable` is stored only in the database. `PATCH /api/projects/:id {shareable}` sets it
(owner only); a project upsert, a projects.toml re-seed or an unrelated edit never changes it. The
global corpus has no switch.

## Owner routes (collector port, owner only)

- `GET /api/public-knowledge/access` → `{aliases, posixGroups, enabled, socketPath?, error?}`.
  `enabled` is true only while the listener is actually bound; `socketPath` is set once a start was
  attempted; `error` says why the start failed (directory not private, a live process on the
  socket, a bind failure).
- `PUT /api/public-knowledge/access` `{aliases, posixGroups}` — entries trimmed, deduplicated,
  alias- or group-shaped, at most 200 each; answers with the same view as GET
- `GET /api/public-knowledge/usage?limit=` → `{calls:[{at,alias,endpoint,query,status}]}`

## Enabling it

1. Start the collector with `STANDUP_PUBLIC_KB=1` and `STANDUP_PUBLIC_KB_IDENTITY_HEADER=<header>`,
   the header your relay stamps with the caller's alias (optionally `STANDUP_PUBLIC_KB_SOCKET=<path>`).
   Both are required: with only `STANDUP_PUBLIC_KB=1` the listener does not start. The collector
   logs the socket path.
2. Share the socket through an authenticating tunnel or reverse proxy that strips any client copy
   of that header and stamps it, naming who may connect. For example, with a tunnel CLI that can
   forward a Unix socket:

   ```
   tunnel-cli open unix:$HOME/.local/share/standup/public/kb.sock --name standup-kb --allow alice,bob
   ```

3. Allow the same people in Standup: `PUT /api/public-knowledge/access` from the owner's console.

A teammate then calls it with whatever credentials the tunnel service accepts:

```
curl -s -H 'Authorization: Bearer <token>' 'https://owner-standup-kb.tunnels.example.com/api/public/knowledge/v1/search?q=tunnel+identity&limit=5'
curl -s -H 'Authorization: Bearer <token>' 'https://owner-standup-kb.tunnels.example.com/api/public/knowledge/v1/docs/global/some-runbook'
```
