import { getRunAbortSignal } from "./command-service.js";

/** Use the same run-scoped abort signal for every direct Notebook model call. */
export function notebookGenerationInvokeOptions(runId?: string): { signal?: AbortSignal } {
  const signal = runId ? getRunAbortSignal(runId) : undefined;
  return signal ? { signal } : {};
}

export type NotebookGenerationInput = {
  runId?: string;
  providerId?: string;
  model?: string;
  isCancelled?: () => boolean;
  generate?: (system: string, user: string) => Promise<string>;
};

export function assertNotebookGenerationActive(input: Pick<NotebookGenerationInput, "isCancelled">) {
  if (!input.isCancelled?.()) return;
  const error = new Error("Notebook generation cancelled.");
  error.name = "RunCancelledError";
  throw error;
}

export async function planNotebookWithLlm(system: string, user: string, input: NotebookGenerationInput): Promise<string> {
  assertNotebookGenerationActive(input);
  if (input.generate) {
    const response = await input.generate(system, user);
    assertNotebookGenerationActive(input);
    return response;
  }
  const { listProviders } = await import("./store.js");
  const { createChatModel } = await import("./providers.js");
  const providers = await listProviders();
  assertNotebookGenerationActive(input);
  const provider = input.providerId ? providers.find((p) => p.id === input.providerId) : providers[0];
  if (!provider) throw new Error("Configure a chat provider first (Providers button, top right).");
  const modelName = input.model || provider.models[0];
  if (!modelName) throw new Error("No chat model selected.");
  const llm = await createChatModel(provider, modelName);
  assertNotebookGenerationActive(input);
  const res = await llm.invoke([
    { role: "system", content: system } as never,
    { role: "user", content: user } as never,
  ], notebookGenerationInvokeOptions(input.runId));
  assertNotebookGenerationActive(input);
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
}
