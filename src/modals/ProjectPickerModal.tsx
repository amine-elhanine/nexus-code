import React from "react";
import { Modal } from "../components/common/Modal.js";

export function ProjectPickerModal({
  name,
  setName,
  root,
  setRoot,
  onChooseFolder,
  onCreate,
  onClose,
}: {
  name: string;
  setName: (name: string) => void;
  root: string;
  setRoot: (root: string) => void;
  onChooseFolder: () => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Create project"
      subtitle="Add a local repository as a persistent Nexus project"
      onClose={onClose}
    >
      <label>
        Project name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="My application"
        />
      </label>
      <label>
        Local folder
        <input
          value={root}
          onChange={(event) => setRoot(event.target.value)}
          placeholder="C:\Users\you\code\my-app"
        />
      </label>
      <div className="modal-actions">
        <button className="secondary" onClick={onChooseFolder}>
          Choose folder
        </button>
        <button className="primary" onClick={onCreate} disabled={!name.trim() || !root.trim()}>
          Create project
        </button>
      </div>
    </Modal>
  );
}
