# add-xmpp

Adds XMPP as a messaging channel using the V1 channel pattern.

## What this skill adds

| File | Purpose |
|------|---------|
| `src/channels/xmpp.ts` | XMPP channel implementation |
| `src/xmpp-client.d.ts` | Ambient TypeScript declarations for `@xmpp/client` |
| `src/channels/index.ts` | Adds `import './xmpp.js'` to the barrel |

Dependency added: `@xmpp/client` (npm).

## Environment variables

Add to `.env`:

```
XMPP_JID=claw@chat.mollensoft.org      # required — bot's full JID
XMPP_PASSWORD=your-password            # required — bot account password
XMPP_RESOURCE=nanoclaw                 # optional — XMPP resource string (default: nanoclaw)
```

If `XMPP_JID` or `XMPP_PASSWORD` is absent, the channel is skipped at startup with a debug log — no error.

## Connection details

- Server: `chat.mollensoft.org`, port 5223
- Transport: Direct TLS (`xmpps://`, TLS from the first byte on port 5223)
- Auth: SASL (SCRAM-SHA-1 preferred, falls back to PLAIN)
- Scope: DMs only (`type="chat"`). MUC group rooms not implemented (see TODO in `xmpp.ts`).

## Behaviour

**Inbound** — filters to `<message type="chat">` stanzas with a `<body>`. Strips the resource from the sender JID (`user@domain/resource` → `user@domain`). Drops messages sent by the bot itself (echo prevention). Calls `onMessage(senderBareJid, message)`.

**Outbound** — sends `<message type="chat"><body>…</body></message>`. Long messages are chunked at 8 KB stanza boundary.

**Routing** — `ownsJid()` returns `true` for any JID whose domain is `chat.mollensoft.org`.

**Reconnect** — exponential backoff starting at 5 s, capped at 60 s, gives up after 10 attempts (host process restart expected at that point).

**Typing** — `setTyping(jid, true)` sends XEP-0085 `<composing/>`. Full chat state notifications (paused, inactive, gone) are a TODO.

## How to reinstall from scratch

```bash
# 1. Install the dependency (already in package.json after first install)
npm install @xmpp/client

# 2. Copy the channel file and type declaration
#    (they live in src/channels/xmpp.ts and src/xmpp-client.d.ts on the skill/add-xmpp branch)

# 3. Add the barrel import to src/channels/index.ts:
#    import './xmpp.js';

# 4. Add credentials to .env (see above)

# 5. Rebuild
npm run build

# 6. Restart the service
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

## Troubleshooting

**Channel skipped at startup** — check that `XMPP_JID` and `XMPP_PASSWORD` are set in `.env`.

**Auth failure (`XMPP stream error`)** — verify credentials against the server. The bot account must exist on `chat.mollensoft.org`.

**No inbound messages** — confirm the sender's XMPP client is sending `type="chat"` (not `type="groupchat"`). Check `logs/nanoclaw.log` for XMPP stanza errors.

**Max reconnect attempts reached** — the service will log this and stop retrying. Restart NanoClaw to reset the counter.
