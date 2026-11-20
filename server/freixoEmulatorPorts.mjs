export function freixoEmulatorPorts(alternate) {
  return alternate ? { firestore: 18080, auth: 19099, http: 13219, hub: 14400, logging: 14500, websocket: 19150 }
    : { firestore: 8080, auth: 9099, http: 3219 };
}
