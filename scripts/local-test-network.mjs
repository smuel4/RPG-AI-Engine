import { Socket } from 'node:net';

// HTTP, TLS and the Firebase transports use TCP sockets. Keep local IPC
// available to the test runner and tsx. Mock fetches do not open sockets.
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const pipe = typeof first === 'string' ? first : first?.path;
  const localPipe = typeof pipe === 'string' && (process.platform === 'win32'
    ? /^\\\\[.?]\\pipe\\/i.test(pipe) : pipe.startsWith('/'));
  if (localPipe && first?.port === undefined) {
    return connect.apply(this, args);
  }
  process.exitCode = 1;
  throw new Error('Conexão TCP proibida no gate local.');
};
