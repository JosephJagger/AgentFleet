import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import type { SQLInputValue } from "node:sqlite";

export interface PostgresOptions {
  url: string;
  schema?: string;
  /** Tests only: a newly created, randomly named schema, removed on close. */
  temporary?: boolean;
  timeoutMs?: number;
}
export interface DatabaseStatement {
  get(...values: SQLInputValue[]): unknown;
  all(...values: SQLInputValue[]): unknown[];
  run(...values: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
export interface DatabaseConnection {
  exec(sql: string): void;
  prepare(sql: string): DatabaseStatement;
  readBatch?(sql: string, sets: SQLInputValue[][]): unknown[][];
  close(): void;
}

/**
 * Transitional driver: retain the existing synchronous service/transaction contract.
 * pg owns its socket in a worker; the main thread waits for bounded requests. This
 * is intentionally not a throughput optimization. Keep PostgreSQL close to the app.
 * A failed/timed-out connection is poisoned, never retried after an uncertain write.
 */
export class PostgresDatabase implements DatabaseConnection {
  private readonly worker: Worker;
  private readonly port;
  private readonly signal = new Int32Array(new SharedArrayBuffer(4));
  private closed = false;
  private readonly timeout: number;

  constructor(options: PostgresOptions) {
    const url = new URL(options.url);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("DATABASE_URL must be a PostgreSQL URL");
    if (options.schema && !/^[a-z][a-z0-9_]{0,62}$/.test(options.schema)) throw new Error("Invalid PostgreSQL schema name");
    if (options.temporary && !/^af_test_[a-f0-9]+$/.test(options.schema ?? "")) throw new Error("Temporary schemas must use a fresh af_test_ name");
    this.timeout = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeout) || this.timeout < 100 || this.timeout > 120_000) throw new Error("Invalid database timeout");
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.worker = new Worker(new URL("./postgres-worker.js", import.meta.url), {
      workerData: { options: { ...options, timeoutMs: this.timeout }, port: channel.port2, signal: this.signal },
      transferList: [channel.port2],
      execArgv: [],
    });
    this.worker.on("error", () => { this.closed = true; this.port.close(); });
    this.worker.unref();
    this.port.unref();
    this.call("init");
  }

  private call(action: string, sql?: string, values?: SQLInputValue[], sets?: SQLInputValue[][]): { rows: unknown[]; rowCount: number } {
    if (this.closed) throw new Error("PostgreSQL connection is closed; restart the service before retrying");
    Atomics.store(this.signal, 0, 0);
    this.port.postMessage({ action, sql, values, sets });
    if (Atomics.wait(this.signal, 0, 0, this.timeout + 2_000) === "timed-out") {
      this.closed = true;
      this.port.close();
      void this.worker.terminate();
      throw new Error("PostgreSQL request timed out; connection closed, write outcome may be unknown");
    }
    const response = receiveMessageOnPort(this.port)?.message;
    if (!response) {
      this.closed = true;
      this.port.close();
      void this.worker.terminate();
      throw new Error("PostgreSQL worker stopped without a response");
    }
    if (response.error) {
      if (action === "init" || response.fatal) {
        this.closed = true;
        this.port.close();
        void this.worker.terminate();
      }
      throw Object.assign(new Error(response.error.message), { code: response.error.code });
    }
    return response;
  }

  exec(sql: string): void { this.call("exec", sql); }
  readBatch(sql: string, sets: SQLInputValue[][]): unknown[][] {
    return this.call("batch", sql, undefined, sets).rows as unknown[][];
  }
  prepare(sql: string): DatabaseStatement {
    return {
      get: (...values) => this.call("query", sql, values).rows[0],
      all: (...values) => this.call("query", sql, values).rows,
      run: (...values) => ({ changes: this.call("query", sql, values).rowCount, lastInsertRowid: 0 }),
    };
  }
  close(): void {
    if (this.closed) return;
    try { this.call("close"); }
    finally { this.closed = true; this.port.close(); void this.worker.terminate(); }
  }
}
