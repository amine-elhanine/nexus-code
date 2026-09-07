import { Modal } from "../components/common/Modal.js";
import { SkillsManager } from "../components/settings/SkillsManager.js";

export function SkillsModal({
  hasProject,
  enabled,
  onToggle,
  onClose,
}: {
  hasProject: boolean;
  enabled: boolean;
  onToggle: (enabled: boolean) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Modal title="Skills" subtitle="Manage step-by-step instructions and guidelines for your coding agent." onClose={onClose}>
      <SkillsManager hasProject={hasProject} enabled={enabled} onToggle={onToggle} />
    </Modal>
  );
}
