/**
 * src/tests/unix-backend-transport.test.ts
 *
 * Integration-style unit tests for the Unix backend HTTP transport:
 *
 *   - Transport failures (DNS failure, connection refused, timeout, TLS
 *     error) reject with CurlTransportError including exit code and stderr
 *   - HTTP 4xx/5xx responses remain *valid responses* (no throw)
 *   - Authorization auto-injection detects existing headers case-insensitively
 *     and honors explicit empty values as opt-out
 *   - SHOGUN_DEBUG output never leaks secrets (headers, sensitive query params)
 *
 * Uses only local resources: loopback HTTP servers, a closed port, and a
 * reserved-invalid DNS name. Requires `curl` on PATH (CI runners have it).
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import { executeRequest, CurlTransportError } from '../backends/unix-backend.js';
import type { ShogunRequest, ShogunResponse } from '../types.js';

// ---------------------------------------------------------------------------
// Local server helpers
// ---------------------------------------------------------------------------

const servers: Array<http.Server | net.Server> = [];

function trackServer<T extends http.Server | net.Server>(s: T): T {
  servers.push(s);
  return s;
}

/** Loopback HTTP server that echoes received headers as a JSON body. */
function startEchoServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = trackServer(http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ headers: req.headers }));
    }));
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

/** Loopback HTTP server that accepts connections but never responds. */
function startSilentServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = trackServer(http.createServer(() => {
      // Intentionally never respond — forces curl --max-time timeout
    }));
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

/** Find a free port, then stop listening — connections to it get refused. */
function getClosedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

after(async () => {
  await Promise.all(
    servers.map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve())),
    ),
  );
});

function makeRequest(url: string, headers: Record<string, string> = {}): ShogunRequest {
  return {
    method: 'GET',
    url,
    path: '/',
    headers,
    params: {},
  };
}

// ---------------------------------------------------------------------------
// Transport failures reject with CurlTransportError (#31)
// ---------------------------------------------------------------------------

describe('executeRequest() — transport failures', () => {

  test('connection refused rejects with CurlTransportError (exit 7)', async () => {
    const port = await getClosedPort();
    await assert.rejects(
      executeRequest(makeRequest(`http://127.0.0.1:${port}/`), {}, { timeout: 5 }),
      (err: unknown) => {
        assert.ok(err instanceof CurlTransportError, `expected CurlTransportError, got: ${err}`);
        assert.equal(err.exitCode, 7);
        assert.match(err.message, /exit code 7/);
        return true;
      },
    );
  });

  test('DNS failure rejects with CurlTransportError (exit 6)', async () => {
    // .invalid TLD is reserved (RFC 2606) — resolution always fails
    const host = `shogun-dns-test-${Date.now()}.invalid`;
    await assert.rejects(
      executeRequest(makeRequest(`http://${host}/`), {}, { timeout: 5 }),
      (err: unknown) => {
        assert.ok(err instanceof CurlTransportError, `expected CurlTransportError, got: ${err}`);
        assert.equal(err.exitCode, 6);
        assert.match(err.message, /Could not resolve host/);
        return true;
      },
    );
  });

  test('timeout rejects with CurlTransportError (exit 28)', async () => {
    const port = await startSilentServer();
    await assert.rejects(
      executeRequest(makeRequest(`http://127.0.0.1:${port}/`), {}, { timeout: 1 }),
      (err: unknown) => {
        assert.ok(err instanceof CurlTransportError, `expected CurlTransportError, got: ${err}`);
        assert.equal(err.exitCode, 28);
        return true;
      },
    );
  });

  test('TLS error (https:// to plain HTTP server) rejects with CurlTransportError', async () => {
    const port = await startEchoServer();
    await assert.rejects(
      executeRequest(makeRequest(`https://127.0.0.1:${port}/`), {}, { timeout: 5 }),
      (err: unknown) => {
        assert.ok(err instanceof CurlTransportError, `expected CurlTransportError, got: ${err}`);
        // 35 = SSL connect error, 56 = recv failure during TLS handshake
        assert.ok(
          err.exitCode === 35 || err.exitCode === 56,
          `expected TLS-related exit code 35 or 56, got ${err.exitCode}`,
        );
        return true;
      },
    );
  });

  test('transport error message includes sanitized stderr and exit code', async () => {
    const port = await getClosedPort();
    await assert.rejects(
      executeRequest(makeRequest(`http://127.0.0.1:${port}/`), {}, { timeout: 5 }),
      (err: unknown) => {
        assert.ok(err instanceof CurlTransportError);
        assert.match(err.message, /curl transport failure \(exit code 7\)/);
        assert.match(err.message, /Failed to connect/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP error responses are valid responses, not transport failures (#31)
// ---------------------------------------------------------------------------

describe('executeRequest() — HTTP error statuses remain valid responses', () => {

  test('HTTP 500 resolves normally with status 500', async () => {
    const server = trackServer(http.createServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    }));
    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

    const response = await executeRequest(
      makeRequest(`http://127.0.0.1:${port}/`), {}, { timeout: 5 },
    );
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: 'boom' });
  });

  test('HTTP 404 resolves normally with status 404', async () => {
    const server = trackServer(http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }));
    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

    const response = await executeRequest(
      makeRequest(`http://127.0.0.1:${port}/`), {}, { timeout: 5 },
    );
    assert.equal(response.status, 404);
    assert.equal(response.raw, 'not found');
  });
});

// ---------------------------------------------------------------------------
// Authorization auto-injection is case-insensitive (#35)
// ---------------------------------------------------------------------------

describe('executeRequest() — Authorization auto-injection', () => {
  const env = { AUTH_TOKEN: 'test-token-123' };

  test('injects Bearer token when no Authorization header is set', async () => {
    const port = await startEchoServer();
    const response = await executeRequest(
      makeRequest(`http://127.0.0.1:${port}/`), env, { timeout: 5 },
    );
    const body = response.body as { headers: Record<string, string> };
    assert.equal(body.headers['authorization'], 'Bearer test-token-123');
  });

  test('does not inject when lowercase authorization header is present', async () => {
    const port = await startEchoServer();
    const response = await executeRequest(
      makeRequest(`http://127.0.0.1:${port}/`, { authorization: 'Custom scheme' }),
      env,
      { timeout: 5 },
    );
    const body = response.body as { headers: Record<string, string> };
    assert.equal(body.headers['authorization'], 'Custom scheme');
  });

  test('does not inject when UPPERCASE AUTHORIZATION header is present', async () => {
    const port = await startEchoServer();
    const response = await executeRequest(
      makeRequest(`http://127.0.0.1:${port}/`, { AUTHORIZATION: 'Custom scheme' }),
      env,
      { timeout: 5 },
    );
    const body = response.body as { headers: Record<string, string> };
    assert.equal(body.headers['authorization'], 'Custom scheme');
  });

  test('explicit empty authorization header suppresses injection (opt-out)', async () => {
    const port = await startEchoServer();
    const response = await executeRequest(
      makeRequest(`http://127.0.0.1:${port}/`, { authorization: '' }),
      env,
      { timeout: 5 },
    );
    const body = response.body as { headers: Record<string, string> };
    assert.equal(body.headers['authorization'], undefined);
  });

  test('autoInjectAuth: false disables injection', async () => {
    const port = await startEchoServer();
    const response = await executeRequest(
      makeRequest(`http://127.0.0.1:${port}/`), env, { timeout: 5, autoInjectAuth: false },
    );
    const body = response.body as { headers: Record<string, string> };
    assert.equal(body.headers['authorization'], undefined);
  });

  test('explicit Authorization header (canonical casing) still suppresses injection', async () => {
    const port = await startEchoServer();
    const response = await executeRequest(
      makeRequest(`http://127.0.0.1:${port}/`, { Authorization: 'Basic abc' }),
      env,
      { timeout: 5 },
    );
    const body = response.body as { headers: Record<string, string> };
    assert.equal(body.headers['authorization'], 'Basic abc');
  });
});

// ---------------------------------------------------------------------------
// SHOGUN_DEBUG output never leaks secrets (#30)
// ---------------------------------------------------------------------------

describe('executeRequest() — debug output redaction', () => {

  test('SHOGUN_DEBUG curl-args output redacts Authorization and sensitive query params', async () => {
    const port = await startEchoServer();

    // Capture process.stderr and console.error output
    const chunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const origConsoleError = console.error;
    (process.stderr.write as unknown) = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    console.error = (...args: unknown[]) => {
      chunks.push(args.map(String).join(' ') + '\n');
    };

    const prevDebug = process.env.SHOGUN_DEBUG;
    process.env.SHOGUN_DEBUG = '1';

    try {
      const response: ShogunResponse = await executeRequest(
        makeRequest(
          `http://127.0.0.1:${port}/?token=sekret-token-value`,
          { Authorization: 'Bearer sekret-token-value', 'X-API-Key': 'sekret-api-key' },
        ),
        { AUTH_TOKEN: 'sekret-token-value' },
        { timeout: 5 },
      );
      assert.equal(response.status, 200);
    } finally {
      if (prevDebug === undefined) delete process.env.SHOGUN_DEBUG;
      else process.env.SHOGUN_DEBUG = prevDebug;
      (process.stderr.write as unknown) = origStderrWrite;
      console.error = origConsoleError;
    }

    const debugOutput = chunks.join('');
    assert.ok(debugOutput.includes('curl-args'), 'debug output should include curl-args line');
    assert.ok(!debugOutput.includes('sekret-token-value'), `secret leaked in debug output:\n${debugOutput}`);
    assert.ok(!debugOutput.includes('sekret-api-key'), `api key leaked in debug output:\n${debugOutput}`);
    assert.ok(debugOutput.includes('[REDACTED]'), 'redaction marker should appear in debug output');
  });
});
