import { client, xml } from '@xmpp/client';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import type { Channel, NewMessage } from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';

const XMPP_DOMAIN = 'chat.mollensoft.org';

// Conservative limit: full stanza including envelope must stay under 8KB.
const MAX_STANZA_BYTES = 8192;

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_MAX_ATTEMPTS = 10;

function toBareJid(fullJid: string): string {
  return (fullJid.split('/')[0] ?? fullJid).toLowerCase();
}

// Split text so each UTF-8 encoded chunk fits in maxBytes.
function chunkText(text: string, maxBytes: number): string[] {
  const enc = new TextEncoder();
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let lo = 1;
    let hi = text.length - start;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (enc.encode(text.slice(start, start + mid)).length <= maxBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    chunks.push(text.slice(start, start + lo));
    start += lo;
  }
  return chunks;
}

function makeXmppChannel(
  opts: ChannelOpts,
  botJid: string,
  password: string,
  resource: string,
): Channel {
  const botBareJid = toBareJid(botJid);
  const username = botJid.split('@')[0] ?? botJid;

  let connected = false;
  let stopping = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const xmpp = client({
    service: `xmpps://${XMPP_DOMAIN}:5223`,
    domain: XMPP_DOMAIN,
    username,
    password,
    resource,
  });

  xmpp.on('online', (address) => {
    connected = true;
    reconnectAttempts = 0;
    logger.info({ address: address.toString() }, 'XMPP online');
    // Announce presence so contacts know the bot is available.
    xmpp.send(xml('presence')).catch((err: unknown) => {
      logger.warn({ err }, 'XMPP: failed to send initial presence');
    });
  });

  function scheduleReconnect(): void {
    if (stopping) return;
    if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      logger.error(
        { attempts: reconnectAttempts },
        'XMPP: max reconnect attempts reached — host process will restart the service',
      );
      return;
    }
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** reconnectAttempts,
    );
    reconnectAttempts += 1;
    logger.warn(
      { attempt: reconnectAttempts, delayMs: delay },
      'XMPP: scheduling reconnect',
    );
    reconnectTimer = setTimeout(() => {
      xmpp.start().catch((err: unknown) => {
        logger.error({ err }, 'XMPP: reconnect attempt failed');
      });
    }, delay);
  }

  xmpp.on('offline', () => {
    connected = false;
    logger.info('XMPP offline');
    scheduleReconnect();
  });

  xmpp.on('error', (err) => {
    // Auth failures surface here; log clearly so the operator can diagnose.
    logger.error({ err }, 'XMPP stream error');
  });

  xmpp.on('stanza', (stanza) => {
    try {
      if (!stanza.is('message')) return;
      if (stanza.attrs['type'] !== 'chat') return; // TODO: MUC support (type="groupchat")

      const from = stanza.attrs['from'];
      if (!from) return;

      const senderBareJid = toBareJid(from);
      if (senderBareJid === botBareJid) return; // echo prevention

      const body = stanza.getChild('body')?.getText()?.trim();
      if (!body) return; // typing notifications, receipts, etc.

      const timestamp = new Date().toISOString();
      const senderName = senderBareJid.split('@')[0] ?? senderBareJid;

      // Upsert the chat row before storing the message — messages.chat_jid has
      // a FK on chats.jid, so the row must exist first or storeMessage throws.
      opts.onChatMetadata(senderBareJid, timestamp, senderName, 'xmpp', false);

      const message: NewMessage = {
        id: `xmpp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: senderBareJid,
        sender: senderBareJid,
        sender_name: senderName,
        content: body,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      opts.onMessage(senderBareJid, message);
    } catch (err) {
      logger.error({ err }, 'XMPP: error processing inbound stanza');
    }
  });

  return {
    name: 'xmpp',

    async connect() {
      stopping = false;
      await xmpp.start();
    },

    async disconnect() {
      stopping = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        await xmpp.send(xml('presence', { type: 'unavailable' }));
      } catch {
        // best-effort — ignore send errors during teardown
      }
      await xmpp.stop();
    },

    isConnected() {
      return connected;
    },

    ownsJid(jid: string) {
      // All JIDs on this server belong to this channel.
      // Extract the domain from "local@domain/resource" or "domain".
      const domain = jid.includes('@')
        ? (jid.split('@')[1]?.split('/')[0] ?? '')
        : (jid.split('/')[0] ?? '');
      return domain === XMPP_DOMAIN;
    },

    async sendMessage(to: string, text: string) {
      // Budget: full stanza must fit in MAX_STANZA_BYTES.
      // The envelope (`<message type="chat" to="..."><body></body></message>`)
      // costs roughly 50–80 bytes; subtract that from the body budget.
      const envelopeBytes = new TextEncoder().encode(
        `<message type="chat" to="${to}"><body></body></message>`,
      ).length;
      const maxBodyBytes = MAX_STANZA_BYTES - envelopeBytes;

      for (const chunk of chunkText(text, maxBodyBytes)) {
        await xmpp.send(
          xml('message', { type: 'chat', to }, xml('body', {}, chunk)),
        );
      }
    },

    // TODO: MUC (multi-user chat group rooms) — V1 handles DMs only.

    async setTyping(to: string, isTyping: boolean) {
      // TODO: full XEP-0085 chat state notifications (paused, inactive, gone).
      if (!isTyping) return;
      try {
        await xmpp.send(
          xml(
            'message',
            { type: 'chat', to },
            xml('composing', {
              xmlns: 'http://jabber.org/protocol/chatstates',
            }),
          ),
        );
      } catch (err) {
        logger.warn({ err, to }, 'XMPP: failed to send composing notification');
      }
    },
  };
}

registerChannel('xmpp', (opts) => {
  const env = readEnvFile(['XMPP_JID', 'XMPP_PASSWORD', 'XMPP_RESOURCE']);
  if (!env['XMPP_JID'] || !env['XMPP_PASSWORD']) {
    logger.debug('XMPP: credentials not configured, skipping channel');
    return null;
  }
  const resource = env['XMPP_RESOURCE'] ?? 'nanoclaw';
  return makeXmppChannel(opts, env['XMPP_JID'], env['XMPP_PASSWORD'], resource);
});
