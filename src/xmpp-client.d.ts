// Minimal ambient declarations for @xmpp/client (no bundled types).
declare module '@xmpp/client' {
  export interface XmppElement {
    name: string;
    attrs: Record<string, string>;
    children: Array<XmppElement | string>;
    is(name: string): boolean;
    getChild(name: string): XmppElement | undefined;
    getText(): string;
    toString(): string;
  }

  export interface XmppAddress {
    toString(): string;
    local: string;
    domain: string;
    resource: string;
  }

  export interface XmppClientOptions {
    service: string;
    domain: string;
    username?: string;
    password?: string;
    resource?: string;
  }

  export interface XmppClient {
    on(event: 'online', handler: (address: XmppAddress) => void): this;
    on(event: 'offline', handler: () => void): this;
    on(event: 'error', handler: (err: Error) => void): this;
    on(event: 'stanza', handler: (stanza: XmppElement) => void): this;
    start(): Promise<void>;
    stop(): Promise<void>;
    send(stanza: XmppElement): Promise<void>;
  }

  export function client(options: XmppClientOptions): XmppClient;
  export function xml(
    name: string,
    attrs?: Record<string, string>,
    ...children: Array<XmppElement | string>
  ): XmppElement;
  export function jid(str: string): XmppAddress;
}
