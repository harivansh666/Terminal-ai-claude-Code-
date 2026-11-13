/**
 * bash.ts — Bash Tool
 *
 * Yeh tool model ko terminal commands run karne deta hai.
 * Model command bhejta hai (jaise "ls -la"), hum use execute karte hain,
 * aur output (stdout + stderr) model ko wapas dete hain.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/**
 * `spawn` — Node.js ka built-in function jo ek naya child process start karta hai.
 *
 * Child process matlab: ek alag program run karna apne program ke andar se.
 * Jaise agar hum "ls" command chalana chahte hain, spawn ek naya process banata hai
 * jisme "ls" chalta hai, aur hum uska output padh sakte hain.
 *
 * `spawn` vs `exec`:
 *   - exec: pura output ek baar me deta hai, memory limit hoti hai (~1MB)
 *   - spawn: stream me deta hai, bade outputs ke liye better hai
 */
import { spawn } from "node:child_process";

/**
 * `Tool` type — types.ts se. Har tool me yeh 3 cheezein hoti hain:
 *   1. name       — tool ka naam (model is naam se pehchanta hai)
 *   2. description — model ko batata hai tool kya karta hai
 *   3. parameters  — JSON Schema: model ko batata hai kya arguments bhejne hain
 *   4. execute()   — actual kaam karne wala function
 */
import type { Tool } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum time (milliseconds) ek command ko run karne denge.
 * 60 seconds ke baad command force-kill ho jayegi.
 * Kyun? — Agar model ne koi infinite loop wali command bheji (jaise `sleep 9999`),
 * toh humara program hamesha ke liye ruk jaata. Timeout se yeh nahi hoga.
 */
const TIMEOUT_MS = 60_000; // 60 seconds

/**
 * Maximum output size (bytes) jo hum model ko denge.
 * Stdout + stderr ka total. Zyada hone par hum trim kar denge.
 * Kyun? — Ek command bahut saara output de sakti hai (jaise `cat` kisi badi file ka).
 * Model ke paas token limit hoti hai, isliye output cap karna zaroori hai.
 */
const MAX_OUTPUT_BYTES = 100_000; // ~100 KB

/**
 * Yeh commands KABHI nahi chalenge, chahe model maange.
 * Dangerous commands jo system ko nuksan pahuncha sakti hain.
 */
const BLOCKED_COMMANDS = new Set([
  "rm",      // files delete karta hai
  "rmdir",   // directories delete karta hai
  "mkfs",    // disk format karta hai — BAHUT dangerous
  "dd",      // disk seedha likha ja sakta hai — OS kharab ho sakta hai
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  ":(){ :|:& };:", // fork bomb — CPU crash karta hai
]);

// ---------------------------------------------------------------------------
// Helper: command ka pehla word nikaalo (actual binary name)
// ---------------------------------------------------------------------------

/**
 * `extractCommandName(command)` — Command string se sirf executable ka naam nikaalti hai.
 *
 * Kyun? — Model "ls -la /home" bhejta hai.
 * Hume block list se match karna hai toh "ls" chahiye, puri string nahi.
 *
 * Kaise kaam karta hai:
 *   "rm -rf /"        → "rm"
 *   "  ls   -la"      → "ls"    (.trim() se spaces hataye, .split() se words alag kiye)
 *   "git status"      → "git"
 */
function extractCommandName(command: string): string {
  // .trim()  — string ke aage-peeche ke spaces hatata hai
  // .split(" ")[0] — pehli space tak ka part leta hai (pehla word)
  return command.trim().split(/\s+/)[0]!;
}

// ---------------------------------------------------------------------------
// Helper: actual command run karna (Promise-based)
// ---------------------------------------------------------------------------

/**
 * `runCommand(command, cwd)` — Shell me command run karta hai, output return karta hai.
 *
 * @param command — Puri command string, jaise "ls -la src/"
 * @param cwd     — Working directory (kahan se command chalani hai)
 * @returns       — Promise<string>: stdout + stderr ka combined output
 *
 * Promise kyun?
 * Command run hone me time lagta hai. Hum `await` karenge tabtak.
 * Jab command khatam hogi, Promise resolve hoga output ke saath.
 */
function runCommand(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    /**
     * `spawn(shell, args, options)` — Command ko shell ke through chalata hai.
     *
     * - shell: "/bin/sh" — Unix shell, jisme commands run hoti hain
     * - args: ["-c", command]
     *     -c flag matlab: "yeh string command ki tarah chalao"
     *     Jaise: /bin/sh -c "ls -la" = terminal me "ls -la" likhne jaisa
     *
     * - options.cwd: working directory set karna
     *   Agar nahi diya toh current Node.js process ki directory use hogi
     *
     * - options.env: environment variables pass karna
     *   process.env matlab: system ki saari env variables (PATH, HOME, etc.)
     *   Bina PATH ke command "ls" nahi milegi (shell use PATH to find executables)
     */
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: process.env,
    });

    // Output collect karne ke liye buffers
    // Buffer = binary data ka array (raw bytes)
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    /**
     * `child.stdout` — Command ka standard output stream.
     * Stream = data ka flow, pieces me aata hai (chunks).
     *
     * `.on("data", callback)` — Jab bhi naya chunk aaye, callback call hoti hai.
     * Hum har chunk ko array me save karte hain.
     */
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    /**
     * `child.stderr` — Command ka standard error stream.
     * Jab command koi error print karti hai (jaise "file not found"), woh yahaan aata hai.
     * Production me stderr bhi capture karna zaroori hai kyunki errors useful hoti hain.
     */
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    /**
     * Timeout — agar command TIMEOUT_MS baad bhi chal rahi hai toh kill karo.
     *
     * `setTimeout(fn, ms)` — ms milliseconds baad fn function call karta hai.
     *
     * `child.kill("SIGTERM")` — Process ko terminate signal bhejta hai.
     * SIGTERM = "please gracefully shut down" ka signal.
     * Agar process nahi sunta, toh SIGKILL use hota (force kill).
     */
    const timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${TIMEOUT_MS / 1000}s: "${command}"`));
    }, TIMEOUT_MS);

    /**
     * `child.on("close", callback)` — Jab process band ho jaaye tab yeh chalti hai.
     *
     * @param exitCode — Process ka exit code:
     *   0   = success (command sahi se chali)
     *   non-0 = kuch galat hua (error)
     */
    child.on("close", (exitCode) => {
      // Pehle timeout clear karo (command khatam ho gayi, timeout ki zaroorat nahi)
      // `clearTimeout` — setTimeout ko cancel karta hai
      clearTimeout(timeoutHandle);

      /**
       * `Buffer.concat(array)` — Saare chunks ko ek bade Buffer me jodta hai.
       * Phir `.toString("utf8")` — Binary Buffer ko readable string me convert karta hai.
       */
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      // Output assemble karo
      let output = "";

      if (stdout) {
        output += stdout;
      }

      // Stderr bhi output me include karo (model ko errors bhi dekhni chahiye)
      if (stderr) {
        output += output ? `\n[stderr]\n${stderr}` : `[stderr]\n${stderr}`;
      }

      // Agar output bilkul khaali hai
      if (!output) {
        output = "(no output)";
      }

      /**
       * Output trim karo agar zyada bada hai.
       * `.slice(0, MAX_OUTPUT_BYTES)` — String ka pehla MAX_OUTPUT_BYTES characters leta hai.
       */
      if (output.length > MAX_OUTPUT_BYTES) {
        const trimmed = output.slice(0, MAX_OUTPUT_BYTES);
        output = `${trimmed}\n\n[...output trimmed — ${output.length} total chars, showing first ${MAX_OUTPUT_BYTES}]`;
      }

      // Non-zero exit code = command fail hua, par hum output phir bhi return karte hain
      // Kyun? — Model ko error message dikhna chahiye taaki woh fix kar sake
      if (exitCode !== 0) {
        resolve(`[Exit code: ${exitCode}]\n${output}`);
      } else {
        resolve(output);
      }
    });

    /**
     * `child.on("error", callback)` — Jab process start hi na ho sake.
     * Jaise agar "/bin/sh" exist hi nahi karta (Windows pe aisa hota hai).
     */
    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Failed to start process: ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * `bashTool` — Model ko bash commands run karne deta hai.
 *
 * Model ko yeh bataya jaata hai (via description + parameters):
 *   - Kya karta hai: shell commands run karna
 *   - Kya argument chahiye: `command` (string), optional `working_directory`
 *
 * Model phir aise call karta hai:
 *   { command: "ls -la src/", working_directory: "." }
 *
 * Hum execute karte hain aur output return karte hain.
 */
export const bashTool: Tool = {
  name: "bash",

  description: [
    "Run a shell (bash) command and return its output.",
    "Use for: listing files, running scripts, checking git status, installing packages, etc.",
    "stdout and stderr are both captured.",
    "Avoid commands that modify system state permanently (rm, shutdown, etc.).",
  ].join(" "),

  parameters: {
    // JSON Schema — model ko batata hai kaunse arguments bhejne hain
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to run. Example: 'ls -la' or 'git status'",
      },
      working_directory: {
        type: "string",
        description:
          "Directory to run the command in. Defaults to the project root if not provided.",
      },
    },
    required: ["command"], // `command` zaroori hai, `working_directory` optional hai
  },

  /**
   * `execute(args)` — Actual kaam karne wala function.
   *
   * @param args — Model ka bheja hua object, jaise:
   *   { command: "git log --oneline -5", working_directory: "." }
   *
   * @returns Promise<string> — Command ka output (string me)
   *
   * `async` kyun? — `runCommand` await karta hai, aur await sirf async function me hota hai.
   */
  async execute(args) {
    // args.command ko string me convert karo (TypeScript me args.command `unknown` type hai)
    const command = String(args.command ?? "").trim();

    if (!command) {
      return "Error: No command provided.";
    }

    // Blocked commands check karo
    const cmdName = extractCommandName(command);
    if (BLOCKED_COMMANDS.has(cmdName)) {
      return `Error: Command "${cmdName}" is blocked for safety reasons.`;
    }

    // Working directory — diya hua ya project root (process.cwd())
    // `process.cwd()` — Node.js process ki current working directory return karta hai
    const cwd = args.working_directory
      ? String(args.working_directory)
      : process.cwd();

    try {
      // Command run karo aur output return karo
      return await runCommand(command, cwd);
    } catch (err) {
      // Timeout ya spawn error
      const message = err instanceof Error ? err.message : String(err);
      return `Error: ${message}`;
    }
  },
};

