const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function listTargets(debugBase, fetchImpl, timeoutMs) {
  const response = await fetchImpl(`${debugBase}/json/list`, {signal: AbortSignal.timeout(timeoutMs)});
  if (!response.ok) throw new Error(`target discovery failed: HTTP ${response.status}`);
  return response.json();
}

export async function findTarget(debugBase, predicate, label, {
  timeoutMs = 10000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const target = (await listTargets(debugBase, fetchImpl, Math.min(1000, remaining))).find(predicate);
      if (target) return target;
    } catch (error) {
      if (Date.now() >= deadline) break;
    }
    const retryDelay = Math.min(50, deadline - Date.now());
    if (retryDelay > 0) await wait(retryDelay);
  } while (Date.now() < deadline);
  throw new Error(`target not found: ${label}`);
}

export async function closeTarget(debugBase, targetId, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 1000,
} = {}) {
  const response = await fetchImpl(`${debugBase}/json/close/${encodeURIComponent(targetId)}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`target cleanup failed: HTTP ${response.status}`);
}

function connectionError(kind, url) {
  return new Error(`CDP WebSocket ${kind}: ${url}`);
}

export class CdpClient {
  constructor(url, {
    commandTimeoutMs = 10000,
    WebSocketImpl = globalThis.WebSocket,
  } = {}) {
    this.url = url;
    this.commandTimeoutMs = commandTimeoutMs;
    this.socket = new WebSocketImpl(url);
    this.sequence = 0;
    this.pending = new Map();
    this.readySettled = false;
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.readySettled) return;
        this.readySettled = true;
        let timeoutError = connectionError('open timed out', url);
        try {
          this.socket.close();
        } catch (error) {
          timeoutError = new Error(`${timeoutError.message}; socket cleanup failed: ${error.message}`);
        }
        reject(timeoutError);
      }, commandTimeoutMs);
      const settle = (callback, value) => {
        if (this.readySettled) return;
        this.readySettled = true;
        clearTimeout(timeout);
        callback(value);
      };
      this.socket.addEventListener('open', () => settle(resolve), {once: true});
      this.socket.addEventListener('error', () => settle(reject, connectionError('failed', url)), {once: true});
      this.socket.addEventListener('close', () => settle(reject, connectionError('closed', url)), {once: true});
    });
    this.socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        this.failPending(new Error(`invalid CDP response: ${error.message}`));
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener('error', () => this.failPending(connectionError('failed', url)));
    this.socket.addEventListener('close', () => this.failPending(connectionError('closed', url)));
  }

  failPending(error) {
    for (const {reject, timeout} of this.pending.values()) {
      clearTimeout(timeout);
      reject(error);
    }
    this.pending.clear();
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, this.commandTimeoutMs);
      this.pending.set(id, {reject, resolve, timeout});
      try {
        this.socket.send(JSON.stringify({id, method, params}));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this.failPending(connectionError('closed', this.url));
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
