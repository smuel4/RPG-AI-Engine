export function localEmulatorPort(value: string | undefined, fallback: number, variable: string) {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error(`${variable} deve ser uma porta inteira entre 1 e 65535.`);
  }
  return port;
}
