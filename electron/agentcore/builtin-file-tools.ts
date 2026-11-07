// Built-in filesystem tools over an AgentBackend — the port of deepagents'
// built-in tool set (ls / read_file / write_file / edit_file / delete / glob /
// grep / execute). Output strings intentionally match the deepagents formats
// the models and the rest of the pipeline were tuned against: cat -n style
// line numbers on reads, "Successfully wrote to '...'" on writes, per-line
// grep matches, exit-code footers on execute.
import { z } from "zod";
import { defineTool, type AgentTool } from "./tools.js";
import type { AgentBackend } from "./backend.js";

const DEFAULT_READ_LIMIT = 100;
const MAX_LINE_LENGTH = 5000;
const GREP_MAX_COUNT = 200;

/** cat -n style line numbers; overlong lines split into `5.1` continuation rows. */
function formatContentWithLineNumbers(content: string, startLine = 1): string {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const rows: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + startLine;
    if (line.length <= MAX_LINE_LENGTH) {
      rows.push(`${String(lineNum).padStart(6)}\t${line}`);
      continue;
    }
    const numChunks = Math.ceil(line.length / MAX_LINE_LENGTH);
    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      const chunk = line.substring(chunkIdx * MAX_LINE_LENGTH, Math.min((chunkIdx + 1) * MAX_LINE_LENGTH, line.length));
      rows.push(`${String(chunkIdx === 0 ? lineNum : `${lineNum}.${chunkIdx}`).padStart(6)}\t${chunk}`);
    }
  }
  return rows.join("\n");
}

export function createFilesystemTools(backend: AgentBackend, options: { includeExecute?: boolean } = {}): AgentTool[] {
  const tools: AgentTool[] = [];

  tools.push(defineTool({
    name: "ls",
    description: "List files and directories at a path. Root '/' is the workspace root.",
    schema: z.object({ path: z.string().optional().describe("Directory path to list (default: /)") }),
    execute: async ({ path: target }: { path?: string }) => {
      const result = await backend.ls(target || "/");
      if (result.error) return `Error listing files: ${result.error}`;
      if (!result.files.length) return `No files found in ${target || "/"}`;
      const lines = result.files.map((info) => info.is_dir ? `${info.path} (directory)` : `${info.path}${info.size ? ` (${info.size} bytes)` : ""}`);
      return lines.join("\n");
    },
  }));

  tools.push(defineTool({
    name: "read_file",
    description: "Read a file from the workspace with cat -n style line numbers. Supports offset/limit pagination for large files.",
    schema: z.object({
      file_path: z.string().describe("Absolute path to the file to read"),
      offset: z.number().optional().default(0).describe("Line offset to start reading from (0-indexed)"),
      limit: z.number().optional().default(DEFAULT_READ_LIMIT).describe("Maximum number of lines to read"),
    }),
    execute: async ({ file_path, offset = 0, limit = DEFAULT_READ_LIMIT }: { file_path: string; offset?: number; limit?: number }) => {
      const result = await backend.read(file_path, offset, limit);
      if (result.error) return `Error: ${result.error}`;
      const formatted = formatContentWithLineNumbers(result.content, result.startLine ?? offset + 1);
      const remaining = result.totalLines != null && result.endLine != null && result.endLine < result.totalLines
        ? `\n\n[File truncated: showing lines ${result.startLine}-${result.endLine} of ${result.totalLines}. Use offset=${result.endLine} to continue reading.]`
        : "";
      return formatted + remaining;
    },
  }));

  tools.push(defineTool({
    name: "write_file",
    description: "Write text content to a file, creating it (and parent directories) if needed. Overwrites existing content.",
    schema: z.object({
      file_path: z.string().describe("Absolute path where the file should be written."),
      content: z.string().describe("The text content to write to the file. This parameter is required."),
    }),
    execute: async ({ file_path, content }: { file_path: string; content: string }) => {
      const result = await backend.write(file_path, content);
      if (result.error) return result.error;
      return `Successfully wrote to '${file_path}'`;
    },
  }));

  tools.push(defineTool({
    name: "edit_file",
    description: "Exact string replacement in a file. The old_string must match the file content exactly; provide more context to disambiguate, or replace_all to change every occurrence.",
    schema: z.object({
      file_path: z.string().describe("Absolute path to the file to edit"),
      old_string: z.string().describe("String to be replaced (must match exactly)"),
      new_string: z.string().describe("String to replace with"),
      replace_all: z.boolean().optional().default(false).describe("Whether to replace all occurrences"),
    }),
    execute: async ({ file_path, old_string, new_string, replace_all = false }: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }) => {
      const result = await backend.edit(file_path, old_string, new_string, replace_all);
      if (result.error) return result.error;
      return `Successfully replaced ${result.occurrences ?? 1} occurrence(s) in '${file_path}'`;
    },
  }));

  tools.push(defineTool({
    name: "delete",
    description: "Delete a file.",
    schema: z.object({ file_path: z.string().describe("Absolute path to the file to delete.") }),
    execute: async ({ file_path }: { file_path: string }) => {
      const result = await backend.delete(file_path);
      if (result.error) return `Error: ${result.error}`;
      return `Deleted ${result.path ?? file_path}`;
    },
  }));

  tools.push(defineTool({
    name: "glob",
    description: "Find files matching a glob pattern (e.g. '**/*.py', 'src/**/*.ts').",
    schema: z.object({
      pattern: z.string().describe("Glob pattern to match files (e.g., '**/*.py', '*.txt', '/subdir/**/*.md')"),
      path: z.string().optional().describe("Base directory to search from. Defaults to the workspace root."),
    }),
    execute: async ({ pattern, path: base }: { pattern: string; path?: string }) => {
      const result = await backend.glob(pattern, base || "/");
      if (result.error) return `Error finding files: ${result.error}`;
      if (!result.files.length) return `No files found matching pattern '${pattern}'`;
      return result.files.map((info) => info.path).join("\n");
    },
  }));

  tools.push(defineTool({
    name: "grep",
    description: "Literal text search across workspace files (not regex). Returns matching lines with file path and line number.",
    schema: z.object({
      pattern: z.string().describe("Literal text pattern to search for (not regex)"),
      path: z.string().optional().default("/").describe("Base path to search from (default: /)"),
      glob: z.string().optional().nullable().describe("Optional glob pattern to filter files (e.g., '*.py')"),
      max_count: z.number().int().positive().optional().describe("Optional cap on total matches returned."),
      output_mode: z.enum(["files_with_matches", "content", "count"]).optional().default("content").describe("Output format"),
    }),
    execute: async ({ pattern, path: base, glob: globFilter, max_count, output_mode = "content" }: { pattern: string; path?: string; glob?: string | null; max_count?: number; output_mode?: "files_with_matches" | "content" | "count" }) => {
      const result = await backend.grep(pattern, base || "/", globFilter ?? null, max_count ?? GREP_MAX_COUNT);
      if (result.error) return result.error;
      if (!result.matches.length) return `No matches found for pattern '${pattern}'`;
      let body: string;
      if (output_mode === "files_with_matches") body = [...new Set(result.matches.map((m) => m.path))].join("\n");
      else if (output_mode === "count") {
        const counts = new Map<string, number>();
        for (const m of result.matches) counts.set(m.path, (counts.get(m.path) ?? 0) + 1);
        body = [...counts.entries()].map(([p, c]) => `${p}: ${c}`).join("\n");
      } else body = result.matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n");
      const note = result.truncated ? `\n\nNote: the search stopped early because it hit the maximum match count. The matches above are valid but incomplete. Narrow the search (a more specific pattern or a narrower path) to see the rest.` : "";
      return body + note;
    },
  }));

  if (options.includeExecute !== false && backend.execute) {
    tools.push(defineTool({
      name: "execute",
      description: "Execute a shell command inside the workspace. Use for builds, tests, scripts, git and CLI tools. Output is capped; long-running installs/dev-servers are better run in background.",
      schema: z.object({ command: z.string().describe("The shell command to execute") }),
      execute: async ({ command }: { command: string }) => {
        const result = await backend.execute!(command);
        const parts = [result.output];
        if (result.exitCode !== null && result.exitCode !== undefined) {
          parts.push(`\n[Command ${result.exitCode === 0 ? "succeeded" : "failed"} with exit code ${result.exitCode}]`);
        }
        if (result.truncated) parts.push("\n[Output was truncated due to size limits]");
        return parts.join("");
      },
    }));
  }

  return tools;
}
