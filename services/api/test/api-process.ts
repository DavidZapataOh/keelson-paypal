import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** The API in a child process, which a test can kill at any instant and start again. */
export class ApiProcess {
  private child: ChildProcess | undefined;
  private readonly waiters: { match: string; done: () => void }[] = [];

  constructor(
    readonly port: number,
    private readonly env: Record<string, string>,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Starts the process and resolves once it listens. */
  async start(): Promise<void> {
    const child = spawn(process.execPath, [new URL("./api-child.ts", import.meta.url).pathname], {
      env: { ...process.env, ...this.env, PORT: String(this.port) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    this.child = child;
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      for (const w of [...this.waiters]) {
        if (!line.includes(w.match)) continue;
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.done();
      }
    });
    await this.line('"msg":"listening"');
  }

  /** Resolves when the process prints a line containing `match`. */
  line(match: string): Promise<void> {
    return new Promise((done) => this.waiters.push({ match, done }));
  }

  /** `SIGKILL`: nothing in the process runs after it. */
  async kill(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    this.child = undefined;
  }

  async restart(): Promise<void> {
    await this.kill();
    await this.start();
  }
}
