import * as cp from "child_process";

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Processus d'analyse TypeScript persistant : le programme et les fichiers déjà analysés sont conservés entre deux analyses. */
export class TsServer {
  private child?: cp.ChildProcess;
  private buffer = "";
  private pending = new Map<number, Pending>();
  private seq = 0;
  private idle?: NodeJS.Timeout;

  constructor(private script: string, private log: (s: string) => void) {}

  private start() {
    const child = cp.spawn(process.execPath, [this.script, "--server"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
        } catch (e) {
          this.log("[typescript] réponse illisible : " + String(e));
        }
      }
    });
    child.stderr!.on("data", (d: Buffer) => this.log("[typescript] " + d.toString().trim()));
    child.on("exit", () => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Le processus d'analyse TypeScript s'est arrêté."));
      }
      this.pending.clear();
      this.child = undefined;
      this.buffer = "";
    });
    child.on("error", (e) => this.log("[typescript] " + e.message));
    this.child = child;
  }

  analyze(root: string, exclude: string[]): Promise<any> {
    if (!this.child) this.start();
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.dispose(), 10 * 60 * 1000);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Délai dépassé (180 s)."));
        this.dispose();
      }, 180_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(JSON.stringify({ id, root, exclude }) + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  dispose() {
    if (this.idle) clearTimeout(this.idle);
    this.child?.kill();
    this.child = undefined;
  }
}
