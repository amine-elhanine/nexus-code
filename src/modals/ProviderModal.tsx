import { Modal } from "../components/common/Modal.js";
import { ProviderManager } from "../components/settings/ProviderManager.js";
import type { ProviderConfig, ProviderDefinition } from "../types.js";

export function ProviderModal({
  providers,
  definitions,
  onProvidersChange,
  onClose,
}: {
  providers: ProviderConfig[];
  definitions: ProviderDefinition[];
  onProvidersChange: (providers: ProviderConfig[]) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Model providers" subtitle="Connect providers once, then switch between any of their models in each session." onClose={onClose}>
      <ProviderManager providers={providers} definitions={definitions} onProvidersChange={onProvidersChange} />
    </Modal>
  );
}
