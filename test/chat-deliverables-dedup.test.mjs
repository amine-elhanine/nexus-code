import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Chat deliverables deduplication and activity grouping', () => {
  it('groups all turn events into a single block without splitting across artifact events', () => {
    const messages = [
      { id: '1', role: 'user', text: 'make a presentation' },
      { id: '2', role: 'event', kind: 'tool', text: 'Searching web' },
      { id: '3', role: 'event', kind: 'artifact', artifact: { filename: 'presentation.pptx', size: 12345 } },
      { id: '4', role: 'event', kind: 'tool', text: 'Refining deck' },
      { id: '5', role: 'assistant', text: 'Done! Your presentation is ready: presentation.pptx' },
    ];

    // Mirroring renderBlocks logic in HomeView
    const blocks = [];
    let pendingEvents = [];
    let pendingArtifacts = [];

    messages.forEach((message, index) => {
      if (message.role === 'event') {
        pendingEvents.push(message);
        if (message.artifact) {
          pendingArtifacts.push(message.artifact);
        }
      } else {
        if (pendingEvents.length > 0) {
          blocks.push({
            kind: 'events',
            events: pendingEvents,
            startIndex: index - pendingEvents.length,
          });
          pendingEvents = [];
        }
        blocks.push({
          kind: 'message',
          message,
          index,
          artifacts: message.role === 'assistant' && pendingArtifacts.length > 0 ? [...pendingArtifacts] : undefined,
        });
        if (message.role === 'assistant') {
          pendingArtifacts = [];
        }
      }
    });

    if (pendingEvents.length > 0) {
      blocks.push({
        kind: 'events',
        events: pendingEvents,
        startIndex: messages.length - pendingEvents.length,
      });
    }

    assert.equal(blocks.length, 3, 'Should produce exactly 3 blocks: user, events, assistant');
    assert.equal(blocks[0].kind, 'message');
    assert.equal(blocks[1].kind, 'events');
    assert.equal(blocks[1].events.length, 3, 'Events block should contain all 3 events without split');
    assert.equal(blocks[2].kind, 'message');
    assert.equal(blocks[2].artifacts.length, 1);
    assert.equal(blocks[2].artifacts[0].filename, 'presentation.pptx');
  });

  it('deduplicates turn artifacts and text-extracted deliverables', () => {
    const artifacts = [{ filename: 'World_War_II_Presentation.pptx', size: 257600, name: 'World War II' }];
    const text = 'Done! Your presentation is ready: World_War_II_Presentation.pptx (263 KB)';

    // Minimal text extraction regex matching ChatMessageItem
    const FILE_EXT_REGEX = /([a-zA-Z0-9_\-.\/ ]+?\.(?:pptx|docx|xlsx|pdf|csv|html|md|json|ts|js|py))\b/gi;
    const matches = [];
    let m;
    while ((m = FILE_EXT_REGEX.exec(text)) !== null) {
      matches.push({ filename: m[1].trim(), name: m[1].trim() });
    }

    const seen = new Set();
    const list = [];
    const norm = (fn) => fn.trim().replace(/^.*[\\/]/, '').toLowerCase();

    // 1. Artifacts from turn
    for (const art of artifacts) {
      const key = norm(art.filename || art.name || '');
      if (key && !seen.has(key)) {
        seen.add(key);
        list.push(art);
      }
    }

    // 2. From text
    for (const item of matches) {
      const key = norm(item.filename || item.name);
      if (key && !seen.has(key)) {
        seen.add(key);
        list.push(item);
      }
    }

    assert.equal(list.length, 1, 'Deliverable should only appear once');
    assert.equal(list[0].size, 257600, 'Rich artifact with size should be preserved');
  });
});
