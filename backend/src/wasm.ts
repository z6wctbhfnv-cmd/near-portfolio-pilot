/**
 * Runs the strategy WASI module in-process.
 *
 * A tiny, deterministic WASI preview1 shim: stdin is the input buffer, stdout is collected, there
 * are no args, no env, no files, the clock reads 0 and "random" bytes are zeros. The module needs
 * none of these to decide (it is pure), so this is the same computation OutLayer runs in its TEE,
 * only without the attestation. Unknown imports are stubbed to return ENOSYS.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_NOSYS = 52;

class ProcExit extends Error {
  constructor(readonly code: number) {
    super(`proc_exit(${code})`);
  }
}

export type WasmRunResult = { stdout: string; exitCode: number; wasmSha256: string };

export class StrategyWasm {
  private module: WebAssembly.Module | null = null;
  private loadedMtime = 0;
  private sha = "";

  constructor(private readonly path: string) {}

  /** SHA-256 of the module bytes: the code identity recorded with every run and on the NFT. */
  get wasmSha256() {
    this.load();
    return this.sha;
  }

  private load() {
    const mtime = statSync(this.path).mtimeMs;
    if (this.module && mtime === this.loadedMtime) return this.module;
    const bytes = readFileSync(this.path);
    this.sha = createHash("sha256").update(bytes).digest("hex");
    this.module = new WebAssembly.Module(bytes);
    this.loadedMtime = mtime;
    return this.module;
  }

  available(): boolean {
    try {
      this.load();
      return true;
    } catch {
      return false;
    }
  }

  runRaw(input: Uint8Array): WasmRunResult {
    const module = this.load();
    let memory: WebAssembly.Memory | null = null;
    let stdinPos = 0;
    const out: Buffer[] = [];
    const mem = () => {
      if (!memory) throw new Error("module memory not ready");
      return memory;
    };
    const view = () => new DataView(mem().buffer);
    const bytes = () => new Uint8Array(mem().buffer);

    const impl: Record<string, (...args: number[]) => number | bigint | void> = {
      fd_read(fd, iovs, iovsLen, nreadPtr) {
        if (fd !== 0) return ERRNO_BADF;
        let n = 0;
        const dv = view();
        for (let i = 0; i < iovsLen; i++) {
          const ptr = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          const chunk = input.subarray(stdinPos, stdinPos + len);
          bytes().set(chunk, ptr);
          stdinPos += chunk.length;
          n += chunk.length;
          if (chunk.length < len) break;
        }
        dv.setUint32(nreadPtr, n, true);
        return ERRNO_SUCCESS;
      },
      fd_write(fd, iovs, iovsLen, nwrittenPtr) {
        if (fd !== 1 && fd !== 2) return ERRNO_BADF;
        let n = 0;
        const dv = view();
        for (let i = 0; i < iovsLen; i++) {
          const ptr = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          if (fd === 1) out.push(Buffer.from(bytes().slice(ptr, ptr + len)));
          n += len;
        }
        dv.setUint32(nwrittenPtr, n, true);
        return ERRNO_SUCCESS;
      },
      environ_sizes_get(countPtr, sizePtr) {
        view().setUint32(countPtr, 0, true);
        view().setUint32(sizePtr, 0, true);
        return ERRNO_SUCCESS;
      },
      environ_get: () => ERRNO_SUCCESS,
      args_sizes_get(countPtr, sizePtr) {
        view().setUint32(countPtr, 0, true);
        view().setUint32(sizePtr, 0, true);
        return ERRNO_SUCCESS;
      },
      args_get: () => ERRNO_SUCCESS,
      clock_time_get(_id, _precision, timePtr) {
        view().setBigUint64(timePtr, 0n, true);
        return ERRNO_SUCCESS;
      },
      random_get(ptr, len) {
        bytes().fill(0, ptr, ptr + len);
        return ERRNO_SUCCESS;
      },
      fd_prestat_get: () => ERRNO_BADF,
      fd_close: () => ERRNO_SUCCESS,
      fd_fdstat_get(fd, statPtr) {
        if (fd > 2) return ERRNO_BADF;
        const dv = view();
        dv.setUint8(statPtr, 2); // character device
        dv.setUint16(statPtr + 2, 0, true);
        dv.setBigUint64(statPtr + 8, 0n, true);
        dv.setBigUint64(statPtr + 16, 0n, true);
        return ERRNO_SUCCESS;
      },
      sched_yield: () => ERRNO_SUCCESS,
      proc_exit(code) {
        throw new ProcExit(code);
      },
    };

    const wasi: Record<string, unknown> = {};
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.kind !== "function") continue;
      if (imp.module !== "wasi_snapshot_preview1") throw new Error(`unsupported import ${imp.module}.${imp.name}`);
      wasi[imp.name] = impl[imp.name] ?? (() => ERRNO_NOSYS);
    }
    const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi as WebAssembly.ModuleImports });
    memory = instance.exports.memory as WebAssembly.Memory;
    let exitCode = 0;
    try {
      (instance.exports._start as () => void)();
    } catch (e) {
      if (e instanceof ProcExit) exitCode = e.code;
      else throw e;
    }
    return { stdout: Buffer.concat(out).toString("utf8"), exitCode, wasmSha256: this.sha };
  }

  /** Runs one decision. The input is serialised once; those exact bytes are hashed by the module. */
  run<T = unknown>(input: unknown): { output: T; inputJson: string; stdout: string; wasmSha256: string } {
    const inputJson = typeof input === "string" ? input : JSON.stringify(input);
    const res = this.runRaw(new TextEncoder().encode(inputJson));
    if (res.exitCode !== 0) throw new Error(`strategy module exited with ${res.exitCode}`);
    return { output: JSON.parse(res.stdout) as T, inputJson, stdout: res.stdout, wasmSha256: res.wasmSha256 };
  }
}

export const sha256Hex = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
