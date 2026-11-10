import { readFile } from "node:fs/promises";
import type { Tool } from "../types.js";
import { resolve } from "node:path";

export const readTool: Tool = {
    name: "read",
    description: "Read a text file and returns its content",
    parameters: {
        // input schema
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Path to the file, relative to the current folder",
            },
        },
        required: ["path"],
    },
    async execute(args) {
        return readFile(resolve(process.cwd(), String(args.path)), "utf8")
    }


}


// resolve = Path jodne ka function (relative path ko full address banata hai)



// For Understanding this tool this 
// async execute(args) {
//   // args = { path: "src/index.ts" }  <- model ne ye bheja

//   const rawPath = args.path;                       // "src/index.ts"
//   const pathString = String(rawPath);              // "src/index.ts"
//   const cwd = process.cwd();                       // "/home/hari/project"
//   const fullPath = resolve(cwd, pathString);       // "/home/hari/project/src/index.ts"
//   const content = readFileSync(fullPath, "utf8");  // "import ... export ..." (file ka text)

//   return content;                                  // ye wapas model ko jaata hai
// }