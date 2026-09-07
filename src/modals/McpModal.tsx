import { Modal } from "../components/common/Modal.js";
import { McpManager } from "../components/settings/McpManager.js";

export function McpModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="MCP servers"
      subtitle="Connect Model Context Protocol servers — local commands or remote HTTP/SSE endpoints — and their tools join every agent run."
      onClose={onClose}
    >
      <McpManager />
    </Modal>
  );
}
