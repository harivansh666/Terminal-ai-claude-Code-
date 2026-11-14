/**
 * policy.ts — Tool Call Policy Guard
 *
 * Yeh module har tool call ko execute hone SE PEHLE check karta hai.
 * Agar operation dangerous hai toh ya toh block kar do, ya user se confirmation lo.
 *
 * Real-world analogy:
 *   Model = new intern
 *   PolicyGuard = senior developer jo har PR review karta hai
 *   Koi bhi code directly production me nahi jaata without review.
 *
 * Industry me isko kehte hain: "Human-in-the-Loop" (HITL) pattern.
 * Claude Code, Devin, aur Cursor sab yeh pattern use karte hain.
 */

import { createInterface } from "node:readline";
// `createInterface` — Node.js ka built-in module jo terminal se input lene deta hai.
// readline = line-by-line terminal input padhna.
// Hum isse user se "y/n" confirmation maangne ke liye use karenge.

import { resolve, relative, isAbsolute } from "node:path";
// resolve   — relative path ko absolute path me convert karta hai
// relative  — do paths ka relative difference nikalta hai (e.g., "../outside")
// isAbsolute — check karta hai path absolute hai ya nahi

import type { Tool, ToolCallBlock } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * PolicyVerdict — Policy ke 3 possible decisions:
 *
 *  "allow"   → Seedha execute karo, koi sawaal nahi
 *  "confirm" → User se pehle permission lo
 *  "deny"    → Kabhi mat chalao, error return karo
 */
export type PolicyVerdict = "allow" | "confirm" | "deny";

/**
 * PolicyConfig — Aap policy ko customize kar sakte ho:
 *
 *  workspaceRoot   — Sirf is folder ke andar write operations allow hain
 *  alwaysDenyPaths — Yeh files/folders kabhi bhi modify nahi ho sakti
 *  alwaysAllowRead — Read-only operations bina confirmation ke chalein
 *  nonInteractive  — CI/CD me: sab confirmations auto-deny ho jayein
 */
export type PolicyConfig = {
  workspaceRoot: string;
  alwaysDenyPaths?: string[];
  alwaysAllowRead?: boolean;
  nonInteractive?: boolean;
};

// ---------------------------------------------------------------------------
// Operation Classification — Command/Tool kya kar raha hai?
// ---------------------------------------------------------------------------

/**
 * Yeh patterns DESTRUCTIVE operations identify karte hain.
 * Regex use karke command string match karte hain.
 *
 * RegExp = Regular Expression — string patterns match karne ka tool.
 * /\brm\b/  = "rm" word boundary ke saath — "term" ya "formed" match nahi hoga
 */
const DESTRUCTIVE_BASH_PATTERNS: RegExp[] = [
  /\brm\b/,          // file/folder delete
  /\brmdir\b/,       // empty folder delete
  /\bmkfs\b/,        // disk format — OS kharab ho sakta hai
  /\bdd\b/,          // disk direct write
  /\bchmod\s+777\b/, // dangerous permission change
  /\bsudo\b/,        // root access — kuch bhi ho sakta hai
  /\bcurl\b.*\|\s*(ba)?sh/,  // internet se script download karke directly run karna
  /\bwget\b.*\|\s*(ba)?sh/,  // same, wget version
  />\s*\/dev\/(s|h)d/,       // disk seedha likhna
  /shutdown|reboot|halt|poweroff/,
];

/**
 * Yeh patterns READ-ONLY operations identify karte hain — safe hain.
 */
const READ_ONLY_BASH_PATTERNS: RegExp[] = [
  /^ls(\s|$)/,
  /^cat\s/,
  /^echo\s/,
  /^pwd$/,
  /^git\s+(log|status|diff|show|branch|remote)/,
  /^find\s/,
  /^grep\s/,
  /^head\s/,
  /^tail\s/,
  /^wc\s/,
  /^which\s/,
  /^whoami$/,
  /^env$/,
  /^printenv/,
];

/**
 * `classifyBashCommand(command)` — Command ko teen categories me daalta hai.
 *
 * Returns: "safe" | "write" | "destructive"
 *
 * Logic:
 *  1. Pehle check karo — destructive pattern match karta hai? → "destructive"
 *  2. Phir check karo — read-only pattern match karta hai? → "safe"
 *  3. Baaki sab — "write" (hum sure nahi, isliye confirm karo)
 */
function classifyBashCommand(command: string): "safe" | "write" | "destructive" {
  for (const pattern of DESTRUCTIVE_BASH_PATTERNS) {
    if (pattern.test(command)) return "destructive";
  }
  for (const pattern of READ_ONLY_BASH_PATTERNS) {
    if (pattern.test(command)) return "safe";
  }
  return "write"; // unknown = assume karo write ho sakta hai
}

// ---------------------------------------------------------------------------
// Path Safety Check
// ---------------------------------------------------------------------------

/**
 * `isPathInsideWorkspace(targetPath, workspaceRoot)` — Check karta hai path
 * workspace ke andar hai ya bahar.
 *
 * Example:
 *   workspace: /home/user/myproject
 *   target: /home/user/myproject/src/app.ts  → true (andar hai)
 *   target: /home/user/other-project/file.ts → false (bahar hai!)
 *   target: /etc/passwd                      → false (SYSTEM FILE!)
 *
 * `relative(from, to)` — Path difference nikalta hai.
 *   relative("/home/user/myproject", "/home/user/myproject/src") = "src"
 *   relative("/home/user/myproject", "/home/user/other") = "../other"
 *   "../" se start hona matlab path BAHAR hai.
 */
function isPathInsideWorkspace(targetPath: string, workspaceRoot: string): boolean {
  const absoluteTarget = isAbsolute(targetPath)
    ? targetPath
    : resolve(workspaceRoot, targetPath);

  const rel = relative(workspaceRoot, absoluteTarget);

  // ".." se start hota hai matlab workspace ke bahar hai
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * `isProtectedPath(targetPath, deniedPaths, workspaceRoot)` — Check karo path
 * "always deny" list me hai ya nahi.
 */
function isProtectedPath(
  targetPath: string,
  deniedPaths: string[],
  workspaceRoot: string,
): boolean {
  const absoluteTarget = isAbsolute(targetPath)
    ? targetPath
    : resolve(workspaceRoot, targetPath);

  return deniedPaths.some((denied) => {
    const absoluteDenied = isAbsolute(denied) ? denied : resolve(workspaceRoot, denied);
    return absoluteTarget === absoluteDenied || absoluteTarget.startsWith(absoluteDenied + "/");
  });
}

// ---------------------------------------------------------------------------
// User Confirmation (Terminal)
// ---------------------------------------------------------------------------

/**
 * `askUserConfirmation(prompt)` — Terminal me user se y/n maangta hai.
 *
 * `createInterface` ek readline interface banata hai:
 *   input: process.stdin  — keyboard se input
 *   output: process.stdout — screen pe output
 *
 * Returns: Promise<boolean> — true agar user ne "y" diya
 *
 * Kyun Promise?
 * User input asynchronous hoti hai — user kab type karega pata nahi.
 * Promise isliye use kiya taaki hum `await` kar sakein.
 */
async function askUserConfirmation(prompt: string): Promise<boolean> {
  // `createInterface` — readline interface banata hai terminal ke liye
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr, // stdout pe model ka output hai, stderr pe humara prompt
  });

  return new Promise((resolve) => {
    // `rl.question(text, callback)` — text print karo, user ka jawab callback me milega
    rl.question(`\n${prompt} [y/N] `, (answer) => {
      // `rl.close()` — interface band karo (memory leak se bachne ke liye)
      rl.close();
      // `.toLowerCase()` — "Y" aur "y" dono accept karo
      resolve(answer.toLowerCase() === "y");
    });
  });
}

// ---------------------------------------------------------------------------
// Main: PolicyGuard class
// ---------------------------------------------------------------------------

/**
 * `PolicyGuard` — Har tool call execute hone se pehle isse guzarna padta hai.
 *
 * Usage:
 *   const guard = new PolicyGuard({ workspaceRoot: process.cwd() });
 *   const verdict = await guard.check(toolCall);
 *   if (verdict === "deny") return; // execute mat karo
 *
 * Pattern: "Middleware" ya "Interceptor" — real systems me widely used.
 * Express.js middleware, Android permission system — sab yahi pattern hai.
 */
export class PolicyGuard {
  private config: Required<PolicyConfig>;

  /**
   * Constructor — Guard setup karo.
   * `Required<PolicyConfig>` — saare optional fields ko required banata hai defaults ke saath.
   */
  constructor(config: PolicyConfig) {
    // Defaults merge karo — agar user ne kuch specify nahi kiya
    this.config = {
      workspaceRoot: config.workspaceRoot,
      alwaysDenyPaths: config.alwaysDenyPaths ?? [],
      alwaysAllowRead: config.alwaysAllowRead ?? true,
      nonInteractive: config.nonInteractive ?? false,
    };
  }

  /**
   * `check(call)` — Tool call ko evaluate karo aur verdict do.
   *
   * @param call — Model ka tool call (name + arguments)
   * @returns PolicyVerdict — "allow", "confirm", ya "deny"
   *
   * Yeh function har tool ke liye alag logic run karta hai.
   */
  async check(call: ToolCallBlock): Promise<PolicyVerdict> {
    switch (call.name) {
      case "bash":
        return this.checkBash(call);

      case "write":
      case "edit":
      case "create_file":
        return this.checkFileWrite(call);

      case "read":
        // Read operations — by default allow
        return "allow";

      default:
        // Unknown tool — confirm karo
        return this.maybeConfirm(
          `Unknown tool "${call.name}" wants to run with args:\n${JSON.stringify(call.arguments, null, 2)}`,
        );
    }
  }

  // ── Bash command policy ──────────────────────────────────────────────────

  private async checkBash(call: ToolCallBlock): Promise<PolicyVerdict> {
    const command = String(call.arguments.command ?? "");
    const classification = classifyBashCommand(command);

    if (classification === "destructive") {
      console.error(
        `\n[POLICY] BLOCKED: Destructive command detected:\n  $ ${command}`,
      );
      return "deny";
    }

    if (classification === "safe" && this.config.alwaysAllowRead) {
      return "allow";
    }

    // "write" classification — user se confirm karo
    return this.maybeConfirm(
      `Model wants to run:\n  $ ${command}\n\nThis command may modify files or system state.`,
    );
  }

  // ── File write policy ────────────────────────────────────────────────────

  private async checkFileWrite(call: ToolCallBlock): Promise<PolicyVerdict> {
    const filePath = String(call.arguments.path ?? call.arguments.file_path ?? "");

    if (!filePath) {
      return "deny"; // path nahi — kuch galat hai
    }

    // Workspace ke bahar likhna — KABHI NAHI
    if (!isPathInsideWorkspace(filePath, this.config.workspaceRoot)) {
      console.error(
        `\n[POLICY] BLOCKED: Path is outside workspace:\n  ${filePath}`,
      );
      return "deny";
    }

    // Protected path — KABHI NAHI (e.g., .env, secrets)
    if (isProtectedPath(filePath, this.config.alwaysDenyPaths, this.config.workspaceRoot)) {
      console.error(
        `\n[POLICY] BLOCKED: Path is protected:\n  ${filePath}`,
      );
      return "deny";
    }

    // Baaki sab ke liye confirm karo
    return this.maybeConfirm(
      `Model wants to write to:\n  ${filePath}`,
    );
  }

  // ── Confirmation helper ──────────────────────────────────────────────────

  /**
   * `maybeConfirm(message)` — nonInteractive mode me auto-deny, warna user se poocho.
   *
   * nonInteractive kyun?
   * CI/CD pipelines me (GitHub Actions, etc.) koi user nahi hota terminal pe.
   * Wahan hum dangerous operations automatically deny karte hain.
   */
  private async maybeConfirm(message: string): Promise<PolicyVerdict> {
    if (this.config.nonInteractive) {
      console.error(`\n[POLICY] AUTO-DENIED (non-interactive mode):\n  ${message}`);
      return "deny";
    }

    const approved = await askUserConfirmation(`[POLICY] ${message}\n\nAllow?`);
    return approved ? "allow" : "deny";
  }
}

// ---------------------------------------------------------------------------
// Convenience: PolicyGuard ko tool execution ke saath wrap karo
// ---------------------------------------------------------------------------

/**
 * `withPolicy(tools, guard)` — Har tool ke execute() ko policy check se wrap karta hai.
 *
 * Yeh "Decorator pattern" hai — original tool ka behaviour change kiye bina
 * uske upar ek layer add karte hain.
 *
 * Before: tool.execute(args)                    → seedha run
 * After:  guard.check(call) → allow → tool.execute(args)
 *                           → deny  → error return
 *
 * @param tools — Original tools array
 * @param guard — PolicyGuard instance
 * @returns     — Same tools, par ab policy ke saath
 */
export function withPolicy(tools: Tool[], guard: PolicyGuard): Tool[] {
  return tools.map((tool) => ({
    // name, description, parameters — same rehte hain
    ...tool,

    // execute — wrap karo
    async execute(args: Record<string, unknown>): Promise<string> {
      // Ek fake ToolCallBlock banao sirf policy check ke liye
      const fakeCall: ToolCallBlock = {
        type: "toolCall",
        id: "policy-check",
        name: tool.name,
        arguments: args,
      };

      const verdict = await guard.check(fakeCall);

      if (verdict === "deny") {
        return `[Policy] Operation denied: tool "${tool.name}" was blocked by security policy.`;
      }

      // "allow" ya "confirm" aur approved — original tool chalao
      return tool.execute(args);
    },
  }));
}

