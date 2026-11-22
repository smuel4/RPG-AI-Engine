import { Socket } from 'node:net';
import { freixoEmulatorPorts } from '../server/freixoEmulatorPorts.mjs';

const ports = Object.values(freixoEmulatorPorts(true));
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = first?.host ?? (typeof args[1] === 'string' ? args[1] : 'localhost');
  const port = Number(first?.port ?? first);
  const pipe = first?.path ?? first;
  if (typeof pipe === 'string' && first?.port === undefined &&
      (process.platform === 'win32' ? /^\\\\[.?]\\pipe\\/i.test(pipe) : pipe.startsWith('/'))) {
    return connect.apply(this, args);
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(host) || !ports.includes(port)) {
    throw new Error('Destino TCP fora da integração descartável: ' + host + ':' + port);
  }
  return connect.apply(this, args);
};
