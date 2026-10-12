// Integration test for LangChain agent tool adapter (createPluginAgentTools)
// and centralized execution boundary (tool-executor.ts).

import assert from 'node:assert/strict';
import { z } from 'zod';
import { createPluginAgentTools } from '../dist-electron/tool-executor.js';
import { registerCapability, clearAllCapabilities } from '../dist-electron/capability-registry.js';
import { setGrantedPermissions, clearGrantedPermissions } from '../dist-electron/plugin-permissions.js';

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

function reset() {
  clearAllCapabilities();
  clearGrantedPermissions('test-plugin');
}

await test('createPluginAgentTools generates valid LangChain tools matching mode', async () => {
  reset();
  registerCapability({
    owner: 'test-plugin',
    name: 'format_code',
    kind: 'tool',
    description: 'Format project code',
    modes: ['code'],
    permissions: ['fs.read'],
    data: {
      name: 'format_code',
      description: 'Format project code',
      modes: ['code'],
      permissions: ['fs.read'],
      handler: async () => ({ formatted: true }),
    },
  });

  registerCapability({
    owner: 'test-plugin',
    name: 'home_memo',
    kind: 'tool',
    description: 'Create memo',
    modes: ['home'],
    permissions: [],
    data: {
      name: 'home_memo',
      description: 'Create memo',
      modes: ['home'],
      handler: async () => 'memo created',
    },
  });

  // Query in 'code' mode: format_code should be present, home_memo should NOT
  const codeTools = createPluginAgentTools({ mode: 'code' });
  assert.equal(codeTools.length, 1);
  assert.equal(codeTools[0].name, 'plugin_test_plugin_format_code');

  // Query in 'home' mode: home_memo should be present, format_code should NOT
  const homeTools = createPluginAgentTools({ mode: 'home' });
  assert.equal(homeTools.length, 1);
  assert.equal(homeTools[0].name, 'plugin_test_plugin_home_memo');
});

await test('createPluginAgentTools enforces permission checks and denies by default', async () => {
  reset();
  registerCapability({
    owner: 'test-plugin',
    name: 'secure_op',
    kind: 'tool',
    description: 'A secure operation',
    modes: ['code'],
    permissions: ['fs.write'],
    data: {
      name: 'secure_op',
      description: 'A secure operation',
      permissions: ['fs.write'],
      handler: async () => ({ status: 'done' }),
    },
  });

  const tools = createPluginAgentTools({ mode: 'code' });
  assert.equal(tools.length, 1);

  // Without granting permissions, tool call returns error string
  const deniedResult = await tools[0].invoke({});
  assert.match(deniedResult, /\[Plugin Tool Error \(permission\)\]/);
  assert.match(deniedResult, /lacks permission/);

  // Grant permission and retry
  setGrantedPermissions('test-plugin', ['fs.write']);
  const allowedResult = await tools[0].invoke({});
  assert.match(allowedResult, /"status": "done"/);
});

await test('createPluginAgentTools redacts secrets from results', async () => {
  reset();
  setGrantedPermissions('test-plugin', ['network.fetch']);
  registerCapability({
    owner: 'test-plugin',
    name: 'fetch_data',
    kind: 'tool',
    description: 'Fetch external data',
    modes: ['code'],
    permissions: ['network.fetch'],
    data: {
      name: 'fetch_data',
      description: 'Fetch external data',
      permissions: ['network.fetch'],
      handler: async () => ({
        token: 'sk-abcdef1234567890',
        message: 'key retrieved',
      }),
    },
  });

  const tools = createPluginAgentTools({ mode: 'code' });
  const result = await tools[0].invoke({});
  assert.ok(!result.includes('sk-abcdef1234567890'), 'Secret key was not redacted!');
  assert.ok(result.includes('sk-****'), 'Redacted mask sk-**** was not found in result');
});

await test('createPluginAgentTools enforces user approval when requiresApproval is true', async () => {
  reset();
  setGrantedPermissions('test-plugin', ['shell.execute']);
  registerCapability({
    owner: 'test-plugin',
    name: 'dangerous_action',
    kind: 'tool',
    description: 'Run dangerous action',
    modes: ['code'],
    permissions: ['shell.execute'],
    data: {
      name: 'dangerous_action',
      description: 'Run dangerous action',
      permissions: ['shell.execute'],
      requiresApproval: true,
      handler: async () => ({ performed: true }),
    },
  });

  // Without approval callback, denied by default
  const toolsWithoutApproval = createPluginAgentTools({ mode: 'code' });
  const deniedResult = await toolsWithoutApproval[0].invoke({});
  assert.match(deniedResult, /\[Plugin Tool Error \(approval\)\]/);

  // With approval callback that returns false
  const toolsWithRejection = createPluginAgentTools({
    mode: 'code',
    requestApproval: async () => false,
  });
  const rejectedResult = await toolsWithRejection[0].invoke({});
  assert.match(rejectedResult, /\[Plugin Tool Error \(approval\)\]/);
  assert.match(rejectedResult, /denied by user/);

  // With approval callback that returns true
  const toolsWithApproval = createPluginAgentTools({
    mode: 'code',
    requestApproval: async () => true,
  });
  const approvedResult = await toolsWithApproval[0].invoke({});
  assert.match(approvedResult, /"performed": true/);
});

console.log(`\nplugin-agent-tools: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
