/*
 * Originally from:
 * https://github.com/zhukov/webogram
 * Copyright (C) 2014 Igor Zhukov <igor.beatle@gmail.com>
 * https://github.com/zhukov/webogram/blob/master/LICENSE
 */

import MTTransport, {MTConnectionConstructable} from '@lib/mtproto/transports/transport';
import Modes from '@config/modes';
import App from '@config/app';
import indexOfAndSplice from '@helpers/array/indexOfAndSplice';
import HTTP from '@lib/mtproto/transports/http';
import Socket from '@lib/mtproto/transports/websocket';
import TcpObfuscated from '@lib/mtproto/transports/tcpObfuscated';
import {IS_WEB_WORKER} from '@helpers/context';
import {DcId} from '@types';
import {getEnvironment} from '@environment/utils';
import SocketProxied from '@lib/mtproto/transports/socketProxied';
import isValidDcId from '@lib/mtproto/isValidDcId';

export type TransportType = 'websocket' | 'https' | 'http';
export type ConnectionType = 'client' | 'download' | 'upload';
type Servers = {
  [transportType in TransportType]: {
    [connectionType in ConnectionType]: {
      [dcId: DcId]: MTTransport[]
    }
  }
};

// Self-hosted telesrv deployment this build talks to. The MTProto listener
// multiplexes plain TCP and WebSocket on /apiws, fronted by a TLS-terminating
// reverse proxy, so the browser side is always wss://.
const SELF_HOSTED_WS_BASE = 'wss://im.zhufu.de5.net';
const TEST_SUFFIX = Modes.test ? '_test' : '';
const PREMIUM_SUFFIX = '_premium';
const RETRY_TIMEOUT_CLIENT = 3000;
const RETRY_TIMEOUT_DOWNLOAD = 3000;

export function getTelegramConnectionSuffix(connectionType: ConnectionType) {
  return connectionType === 'client' ? '' : '-1';
}

// A dcId can arrive from the service worker's `stream/` route, i.e. from a URL any page
// can craft: interpolated unchecked it turns the endpoint into an attacker-chosen host
// (`1.evil.com/` -> wss://kws1.evil.com/-1.web.telegram.org/apiws). Telegram has exactly
// five DCs, so validate here, before the value can reach a URL or a storage key.
export function assertValidDcId(dcId: DcId): DcId {
  if(!isValidDcId(dcId)) {
    throw new Error('[MT] invalid dcId: ' + dcId);
  }

  return +dcId as DcId;
}

export function constructTelegramWebSocketUrl(_dcId: DcId, connectionType: ConnectionType, premium?: boolean) {
  // * strict `=== '1'`: a "0" from .env is a truthy string and used to keep a
  // * transport enabled against a server that does not serve it.
  if(import.meta.env.VITE_MTPROTO_HAS_WS !== '1') {
    return;
  }

  const dcId = assertValidDcId(_dcId);
  const suffix = getTelegramConnectionSuffix(connectionType);
  const path = connectionType !== 'client' ? 'apiws' + TEST_SUFFIX + (premium ? PREMIUM_SUFFIX : '') : ('apiws' + TEST_SUFFIX);
  // Self-hosted servers run a single DC (telesrv advertises dc=2) and serve
  // MTProto-over-WebSocket at /apiws on the same host as the web client.
  const chosenServer = `${SELF_HOSTED_WS_BASE}/${path}`;

  void dcId; void suffix;
  return chosenServer;
}

export class DcConfigurator {
  private sslSubdomains = ['pluto', 'venus', 'aurora', 'vesta', 'flora'];

  // Self-hosted telesrv: one DC (id 2, matching TELESRV_DC and BASE_DC_ID).
  private dcOptions = [
    {id: 2, host: 'im.zhufu.de5.net', port: 443}
  ];

  public chosenServers: Servers = {} as any;

  private transportSocket = (dcId: DcId, connectionType: ConnectionType, premium?: boolean) => {
    if(import.meta.env.VITE_MTPROTO_HAS_WS !== '1') {
      return;
    }

    const chosenServer = constructTelegramWebSocketUrl(dcId, connectionType, premium);
    const logSuffix = connectionType === 'upload' ? '-U' : connectionType === 'download' ? '-D' : '';

    const retryTimeout = connectionType === 'client' ? RETRY_TIMEOUT_CLIENT : RETRY_TIMEOUT_DOWNLOAD;

    let oooohLetMeLive: MTConnectionConstructable;
    if(import.meta.env.VITE_MTPROTO_SW || !import.meta.env.VITE_SAFARI_PROXY_WEBSOCKET) {
      oooohLetMeLive = Socket;
    } else {
      oooohLetMeLive = (getEnvironment().IS_SAFARI && IS_WEB_WORKER && typeof(SocketProxied) !== 'undefined') /* || true */ ? SocketProxied : Socket;
    }

    return new TcpObfuscated(oooohLetMeLive, dcId, chosenServer, logSuffix, retryTimeout);
  };

  private transportHTTP = (dcId: DcId, connectionType: ConnectionType, premium?: boolean) => {
    // * telesrv serves no HTTP MTProto transport (only /apiws), so this stays off:
    // * .env keeps VITE_MTPROTO_HAS_HTTP empty and the check is strict.
    if(import.meta.env.VITE_MTPROTO_HAS_HTTP !== '1') {
      return;
    }

    let chosenServer: string;
    if(Modes.ssl || !Modes.http) {
      // * Unreachable while VITE_MTPROTO_HAS_HTTP is empty: telesrv serves no
      // * /apiw1, so asking for it only yields a 404 and a -404 transport error.
      chosenServer = 'https://im.zhufu.de5.net/apiw1';
    } else {
      for(const dcOption of this.dcOptions) {
        if(dcOption.id === dcId) {
          chosenServer = 'http://' + dcOption.host + (dcOption.port !== 80 ? ':' + dcOption.port : '') + '/apiw1';
          break;
        }
      }
    }

    const logSuffix = connectionType === 'upload' ? '-U' : connectionType === 'download' ? '-D' : '';
    return new HTTP(dcId, chosenServer, logSuffix);
  };

  public chooseServer(
    dcId: DcId,
    connectionType: ConnectionType = 'client',
    transportType: TransportType = Modes.transport,
    reuse = true,
    premium?: boolean
  ) {
    /* if(transportType === 'websocket' && !Modes.multipleConnections) {
      connectionType = 'client';
    } */

    dcId = assertValidDcId(dcId);

    if(!this.chosenServers.hasOwnProperty(transportType)) {
      this.chosenServers[transportType] = {
        client: {},
        download: {},
        upload: {}
      };
    }

    const servers = this.chosenServers[transportType][connectionType];

    if(!(dcId in servers)) {
      servers[dcId] = [];
    }

    const transports = servers[dcId];

    if(!transports.length || !reuse/*  || (upload && transports.length < 1) */) {
      let transport: MTTransport;

      if(import.meta.env.VITE_MTPROTO_HAS_WS === '1' && import.meta.env.VITE_MTPROTO_HAS_HTTP === '1') {
        transport = (transportType === 'websocket' ? this.transportSocket : this.transportHTTP)(dcId, connectionType, premium);
      } else if(!import.meta.env.VITE_MTPROTO_HTTP) {
        transport = this.transportSocket(dcId, connectionType, premium);
      } else {
        transport = this.transportHTTP(dcId, connectionType, premium);
      }

      if(!transport) {
        console.error('No chosenServer!', dcId);
        return null;
      }

      if(reuse) {
        transports.push(transport);
      }

      return transport;
    }

    return transports[0];
  }

  public static removeTransport<T>(obj: any, transport: T) {
    for(const transportType in obj) {
      // @ts-ignore
      for(const connectionType in obj[transportType]) {
        // @ts-ignore
        for(const dcId in obj[transportType][connectionType]) {
          // @ts-ignore
          const transports: T[] = obj[transportType][connectionType][dcId];
          indexOfAndSplice(transports, transport);
        }
      }
    }
  }
}
