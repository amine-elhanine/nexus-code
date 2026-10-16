// Integration test for live cross-process event bus, dynamic context providers,
// and slash command auto-discovery.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startPluginProcess,
  stopAllPluginProcesses,
  getPluginProcess,
} from '../dist-electron/plugin-process-host.js';
import {
  discoverExecutablePlugin,
  enablePlugin,
  collectDynamicPluginContext,
  clearManagedPlugins,
} from '../dist-electron/plugin-lifecycle.js';
import { evaluatePolicyHooks, emitPluginEvent } from '../dist-electron/plugin-events.js';
import { clearAllCapabilities } from '../dist-electron/capability-registry.js';
import { discoverCustomCommands } from '../dist-electron/custom-commands-service.js';
import { buildSystemPrompt } from '../dist-electron/agent-prompt.js';
import { createHooksMiddleware } from '../dist-electron/hooks-service.js';
import { ToolMessage } from '@langchain/core/messages';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((error) => {
      console.error(`  ✗ ${name}`);
      console.error(error);
      failed++;
    });
}

async function makePlugin(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-live-'));
  const pluginDir = path.join(dir, 'plug');
  await fs.mkdir(pluginDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(pluginDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return { root: dir, pluginDir };
}

async function cleanup(root) {
  await stopAllPluginProcesses().catch(() => undefined);
  clearManagedPlugins();
  clearAllCapabilities();
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}

await test('live cross-process policy hook (tool:before) can deny execution with reason', async () => {
  const { root, pluginDir } = await makePlugin({
    'manifest.json': JSON.stringify({
      manifestVersion: '2.0.0',
      id: 'policy-guard',
      name: 'Policy Guard',
      version: '1.0.0',
      description: 'Guards tool invocations',
      author: 'Tester',
      license: 'MIT',
      apiVersion: '1',
      entry: 'index.js',
      capabilities: ['tools', 'services'],
      permissions: ['fs.read'],
    }),
    'index.js': `
      nexus.on("tool:before", (payload) => {
        if (payload && payload.tool === "builtin:blocked_tool") {
          return { verdict: "deny", reason: "Blocked by policy guard: unsafe operation" };
        }
        return "allow";
      });
    `,
  });

  try {
    const discovered = await discoverExecutablePlugin(pluginDir);
    const enabled = await enablePlugin({ id: 'policy-guard', appVersion: '0.4.5', approvedPermissions: ['fs.read'] });
    assert.equal(enabled.ok, true);

    // Call policy hook for an allowed tool
    const allowedOutcome = await evaluatePolicyHooks('tool:before', { tool: 'builtin:read_file' });
    assert.equal(allowedOutcome.allowed, true);

    // Call policy hook for the blocked tool
    const blockedOutcome = await evaluatePolicyHooks('tool:before', { tool: 'builtin:blocked_tool' });
    assert.equal(blockedOutcome.allowed, false);
    assert.equal(blockedOutcome.deniedBy, 'policy-guard');
    assert.match(blockedOutcome.reason, /Blocked by policy guard: unsafe operation/);
  } finally {
    await cleanup(root);
  }
});

await test('live cross-process observational events stream to runner without blocking', async () => {
  const { root, pluginDir } = await makePlugin({
    'manifest.json': JSON.stringify({
      manifestVersion: '2.0.0',
      id: 'event-observer',
      name: 'Event Observer',
      version: '1.0.0',
      description: 'Observes runs',
      author: 'Tester',
      license: 'MIT',
      apiVersion: '1',
      entry: 'index.js',
      capabilities: ['services'],
    }),
    'index.js': `
      nexus.on("run:start", (payload) => {
        nexus.log("Received run:start for session " + payload.sessionId);
      });
    `,
  });

  try {
    await discoverExecutablePlugin(pluginDir);
    const enabled = await enablePlugin({ id: 'event-observer', appVersion: '0.4.5', approvedPermissions: [] });
    assert.equal(enabled.ok, true);

    const diagnostics = await emitPluginEvent('run:start', { sessionId: 'session-42' });
    assert.equal(diagnostics.invoked, 1);
    assert.equal(diagnostics.errors.length, 0);
  } finally {
    await cleanup(root);
  }
});

await test('dynamic context provider (Pi-style) contributes to prompt generation', async () => {
  const { root, pluginDir } = await makePlugin({
    'manifest.json': JSON.stringify({
      manifestVersion: '2.0.0',
      id: 'env-provider',
      name: 'Environment Context Provider',
      version: '1.0.0',
      description: 'Provides environment context',
      author: 'Tester',
      license: 'MIT',
      apiVersion: '1',
      entry: 'index.js',
      capabilities: ['services'],
    }),
    'index.js': `
      nexus.registerContextProvider(
        { name: "deployment-env", description: "Current deployment target", modes: ["code"] },
        (ctx) => "ENVIRONMENT: production (cluster-us-east-1)"
      );
    `,
  });

  try {
    await discoverExecutablePlugin(pluginDir);
    const enabled = await enablePlugin({ id: 'env-provider', appVersion: '0.4.5', approvedPermissions: [] });
    assert.equal(enabled.ok, true);

    // Query dynamic context in 'code' mode
    const contextSection = await collectDynamicPluginContext({ mode: 'code' });
    assert.match(contextSection, /Plugin Context \(env-provider\/deployment-env\)/);
    assert.match(contextSection, /ENVIRONMENT: production \(cluster-us-east-1\)/);

    // Context should be omitted in 'home' mode due to mode restriction
    const homeContext = await collectDynamicPluginContext({ mode: 'home' });
    assert.equal(homeContext, '');

    // Test system prompt injection
    const prompt = buildSystemPrompt(
      'auto',
      '/workspace',
      'TestProvider',
      'test-model',
      { projectMemory: '', sessionMemory: '' },
      '',
      'complex',
      false,
      'code',
      '',
      null,
      '',
      '',
      contextSection
    );
    assert.match(prompt, /ENVIRONMENT: production \(cluster-us-east-1\)/);
  } finally {
    await cleanup(root);
  }
});

await test('dynamically registered slash commands merge into custom commands autocomplete', async () => {
  const { root, pluginDir } = await makePlugin({
    'manifest.json': JSON.stringify({
      manifestVersion: '2.0.0',
      id: 'cmd-plugin',
      name: 'Command Plugin',
      version: '1.0.0',
      description: 'Provides custom slash command',
      author: 'Tester',
      license: 'MIT',
      apiVersion: '1',
      entry: 'index.js',
      capabilities: ['commands', 'services'],
    }),
    'index.js': `
      nexus.registerCommand({
        name: "deploy",
        description: "Deploy current branch to staging",
        modes: ["code"]
      });
    `,
  });

  try {
    await discoverExecutablePlugin(pluginDir);
    const enabled = await enablePlugin({ id: 'cmd-plugin', appVersion: '0.4.5', approvedPermissions: [] });
    assert.equal(enabled.ok, true);

    const commands = await discoverCustomCommands('/fake/path', 'code');
    const deployCmd = commands.find((c) => c.command === '/deploy');
    assert.ok(deployCmd, 'Command /deploy was not found in discoverCustomCommands');
    assert.equal(deployCmd.name, 'deploy');
    assert.match(deployCmd.description, /Deploy current branch to staging/);
  } finally {
    await cleanup(root);
  }
});

await test('executable plugin tool:before listener intercepts built-in agent tools via createHooksMiddleware', async () => {
  const { root, pluginDir } = await makePlugin({
    'manifest.json': JSON.stringify({
      manifestVersion: '2.0.0',
      id: 'builtin-tool-guard',
      name: 'Builtin Tool Guard',
      version: '1.0.0',
      description: 'Guards built-in write_file tool',
      author: 'Tester',
      license: 'MIT',
      apiVersion: '1',
      entry: 'index.js',
      capabilities: ['services'],
    }),
    'index.js': `
      nexus.on("tool:before", (payload) => {
        if (payload && payload.tool === "write_file" && String(payload.args?.file_path || "").includes(".env")) {
          return { verdict: "deny", reason: "Refusing to overwrite .env file" };
        }
        return "allow";
      });
    `,
  });

  try {
    await discoverExecutablePlugin(pluginDir);
    const enabled = await enablePlugin({ id: 'builtin-tool-guard', appVersion: '0.4.5', approvedPermissions: [] });
    assert.equal(enabled.ok, true);

    // Even with zero shell hooks in hooks.json, createHooksMiddleware activates for executable plugin listeners
    const mw = createHooksMiddleware({ projectRoot: root, hooks: [] });
    assert.ok(mw, 'createHooksMiddleware should return middleware when executable plugin tool:before listener is active');

    let executed = false;
    const deniedResult = await mw.wrapToolCall(
      { tool: { name: 'write_file' }, toolCall: { id: 'call_env', args: { file_path: '.env.production' } } },
      async () => {
        executed = true;
        return 'ok';
      }
    );
    assert.equal(executed, false, 'denied built-in tool call must not execute');
    assert.ok(deniedResult instanceof ToolMessage);
    assert.match(String(deniedResult.content), /Refusing to overwrite \.env file/);

    const allowedResult = await mw.wrapToolCall(
      { tool: { name: 'write_file' }, toolCall: { id: 'call_src', args: { file_path: 'src/index.ts' } } },
      async () => 'written-ok'
    );
    assert.equal(allowedResult, 'written-ok');
  } finally {
    await cleanup(root);
  }
});

console.log(`\nplugin-live-events-and-context: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
