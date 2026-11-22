export function freixoEmulatorPorts(alternate) {
  if (!alternate) return { firestore: 8080, auth: 9099, http: 3219 };
  const preferred = { firestore: 18080, auth: 19099, http: 13219, hub: 24400, logging: 24500, websocket: 29150 };
  if (!process.env.ECHO_FULL_DIRECTORY || !process.env.ECHO_FULL_PORTS) return preferred;
  const ports = JSON.parse(process.env.ECHO_FULL_PORTS);
  const values = Object.keys(preferred).map((name) => ports[name]);
  if (Object.keys(ports).length !== values.length || new Set(values).size !== values.length ||
      values.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535 || [3219, 8080, 9099].includes(port))) {
    throw new Error('Portas inválidas para os emuladores descartáveis.');
  }
  return ports;
}
