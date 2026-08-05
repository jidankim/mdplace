const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function listTargets(debugBase) {
  const response = await fetch(`${debugBase}/json/list`);
  if (!response.ok) throw new Error(`target discovery failed: HTTP ${response.status}`);
  return response.json();
}

export async function findTarget(debugBase, predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const target = (await listTargets(debugBase)).find(predicate);
    if (target) return target;
    await wait(50);
  }
  throw new Error(`target not found: ${label}`);
}

export class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, {once: true});
      this.socket.addEventListener('error', () => reject(new Error(`CDP WebSocket failed: ${url}`)), {once: true});
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const {resolve, reject} = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.sequence;
    this.socket.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }

  close() {
    this.socket.close();
  }
}

export async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}
