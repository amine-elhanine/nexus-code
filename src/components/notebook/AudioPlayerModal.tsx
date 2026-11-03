import React, { useEffect, useRef, useState } from "react";
import { Headphones, Play, Pause, RotateCcw, Volume2, VolumeX, Copy, Check, Radio } from "lucide-react";
import { Modal } from "../common/Modal.js";
import type { NotebookAudioOverview, AudioOverviewTurn } from "../../types.js";
import { CitationSources } from "./CitationSources.js";

export function AudioPlayerModal({
  audio,
  onClose,
  onAskFollowUp,
}: {
  audio: NotebookAudioOverview;
  onClose: () => void;
  onAskFollowUp?: (question: string) => void;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTurnIdx, setCurrentTurnIdx] = useState(0);
  const [speed, setSpeed] = useState<number>(1);
  const [copied, setCopied] = useState(false);
  const [followUpQuery, setFollowUpQuery] = useState("");
  const isPlayingRef = useRef(false);
  isPlayingRef.current = isPlaying;
  const currentTurnRef = useRef(0);
  currentTurnRef.current = currentTurnIdx;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const utteranceTokenRef = useRef(0);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);

  // Stop speech when modal closes or unmounts
  useEffect(() => {
    return () => {
      utteranceTokenRef.current++;
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const speakTurn = (turnIdx: number, rateOverride?: number) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const token = ++utteranceTokenRef.current;
    window.speechSynthesis.cancel();
    if (turnIdx >= audio.turns.length) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      setCurrentTurnIdx(0);
      return;
    }

    const turn = audio.turns[turnIdx];
    const spokenText = turn.text.replace(/\s*\[S\d+\]/g, "").trim() || turn.text;
    const utterance = new SpeechSynthesisUtterance(spokenText);
    utterance.rate = rateOverride ?? speedRef.current;
    // Set distinct pitch for Alex vs Sam
    if (turn.speaker === "Alex") {
      utterance.pitch = 1.05;
    } else {
      utterance.pitch = 0.88;
    }

    utterance.onend = () => {
      if (utteranceTokenRef.current !== token) return;
      if (isPlayingRef.current) {
        const nextIdx = turnIdx + 1;
        if (nextIdx < audio.turns.length) {
          currentTurnRef.current = nextIdx;
          setCurrentTurnIdx(nextIdx);
          speakTurn(nextIdx);
        } else {
          isPlayingRef.current = false;
          setIsPlaying(false);
          currentTurnRef.current = 0;
          setCurrentTurnIdx(0);
        }
      }
    };

    utterance.onerror = (event) => {
      if (utteranceTokenRef.current !== token) return;
      if (event?.error === "canceled" || event?.error === "interrupted") return;
      isPlayingRef.current = false;
      setIsPlaying(false);
    };

    window.speechSynthesis.speak(utterance);

    // Auto-scroll the playing turn into view
    const el = document.getElementById(`audio-turn-${turnIdx}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };

  const togglePlay = () => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    if (isPlaying) {
      utteranceTokenRef.current++;
      window.speechSynthesis.cancel();
      isPlayingRef.current = false;
      setIsPlaying(false);
    } else {
      isPlayingRef.current = true;
      setIsPlaying(true);
      speakTurn(currentTurnIdx);
    }
  };

  const resetAudio = () => {
    utteranceTokenRef.current++;
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    isPlayingRef.current = false;
    setIsPlaying(false);
    currentTurnRef.current = 0;
    setCurrentTurnIdx(0);
  };

  const jumpToTurn = (index: number) => {
    currentTurnRef.current = index;
    setCurrentTurnIdx(index);
    if (isPlayingRef.current) {
      speakTurn(index);
    }
  };

  const copyTranscript = async () => {
    const fullText = audio.turns
      .map((t) => `${t.speaker.toUpperCase()}: ${t.text}`)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const handleFollowUp = () => {
    const q = followUpQuery.trim();
    if (!q) return;
    const currentTurn = audio.turns[currentTurnIdx];
    const context = currentTurn
      ? `In the Audio Overview "${audio.title}", Alex and Sam noted: "${currentTurn.text}". Follow-up: ${q}`
      : `In the Audio Overview "${audio.title}", follow-up: ${q}`;
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    onClose();
    onAskFollowUp?.(context);
  };

  const progressPercent = audio.turns.length > 0
    ? Math.round(((currentTurnIdx + 1) / audio.turns.length) * 100)
    : 0;

  return (
    <Modal
      title={audio.title}
      subtitle={`Deep Dive Podcast · ~${audio.durationMinutes} min · 2 Hosts (Alex & Sam)`}
      onClose={onClose}
    >
      <div className="audio-overview-container" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Playback Controls Bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--bg-elevated, #242424)",
            border: "1px solid var(--border-subtle, #333)",
            borderRadius: 8,
            padding: "10px 14px",
            flexWrap: "wrap",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={togglePlay}
              className="primary"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 14px",
                borderRadius: 20,
                fontSize: 12,
                cursor: "pointer",
              }}
              title={isPlaying ? "Pause discussion" : "Play discussion"}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
              <span>{isPlaying ? "Pause" : "Play Episode"}</span>
            </button>

            <button
              onClick={resetAudio}
              className="pane-action"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }}
              title="Reset to beginning"
            >
              <RotateCcw size={12} />
              <span>Restart</span>
            </button>

            <div style={{ fontSize: 11, opacity: 0.8, marginLeft: 6 }}>
              Turn {currentTurnIdx + 1} of {audio.turns.length} ({progressPercent}%)
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
              <span style={{ opacity: 0.7 }}>Speed:</span>
              {[0.75, 1, 1.25, 1.5, 2].map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    speedRef.current = s;
                    setSpeed(s);
                    if (isPlayingRef.current) {
                      speakTurn(currentTurnRef.current, s);
                    }
                  }}
                  style={{
                    padding: "2px 6px",
                    fontSize: 10,
                    borderRadius: 4,
                    border: "1px solid var(--border-subtle, #333)",
                    background: speed === s ? "var(--accent, #3b82f6)" : "transparent",
                    color: speed === s ? "#fff" : "inherit",
                    cursor: "pointer",
                  }}
                >
                  {s}x
                </button>
              ))}
            </div>

            <button
              onClick={copyTranscript}
              className="pane-action"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }}
              title="Copy full script to clipboard"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? "Copied" : "Copy Script"}</span>
            </button>
          </div>
        </div>

        {/* Chapters Strip */}
        {audio.chapters && audio.chapters.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
            <span style={{ fontSize: 11, opacity: 0.7, fontWeight: 600, whiteSpace: "nowrap" }}>Chapters:</span>
            {audio.chapters.map((ch, idx) => {
              const active = currentTurnIdx >= ch.turnIndex &&
                (idx === audio.chapters.length - 1 || currentTurnIdx < audio.chapters[idx + 1].turnIndex);
              return (
                <button
                  key={idx}
                  onClick={() => jumpToTurn(ch.turnIndex)}
                  style={{
                    padding: "3px 8px",
                    fontSize: 11,
                    whiteSpace: "nowrap",
                    borderRadius: 12,
                    border: active ? "1px solid var(--accent, #3b82f6)" : "1px solid var(--border-subtle, #333)",
                    background: active ? "rgba(59, 130, 246, 0.15)" : "transparent",
                    color: active ? "var(--accent, #3b82f6)" : "inherit",
                    cursor: "pointer",
                  }}
                >
                  {ch.title}
                </button>
              );
            })}
          </div>
        )}

        {/* Script & Conversation View */}
        <div
          ref={transcriptContainerRef}
          style={{
            maxHeight: "56vh",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            paddingRight: 4,
          }}
        >
          {audio.turns.map((turn, idx) => {
            const isTurnActive = idx === currentTurnIdx;
            const isAlex = turn.speaker === "Alex";
            return (
              <div
                key={idx}
                id={`audio-turn-${idx}`}
                onClick={() => jumpToTurn(idx)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  padding: "10px 14px",
                  borderRadius: 8,
                  borderLeft: isTurnActive
                    ? "3px solid var(--accent, #3b82f6)"
                    : isAlex
                    ? "3px solid #60a5fa"
                    : "3px solid #c084fc",
                  background: isTurnActive
                    ? "rgba(59, 130, 246, 0.08)"
                    : "var(--bg-elevated, #1c1c1c)",
                  cursor: "pointer",
                  transition: "background 0.15s ease",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: isAlex ? "rgba(96, 165, 250, 0.2)" : "rgba(192, 132, 252, 0.2)",
                        color: isAlex ? "#93c5fd" : "#d8b4fe",
                      }}
                    >
                      {turn.speaker}
                    </span>
                    {isTurnActive && isPlaying && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--accent, #3b82f6)" }}>
                        <Radio size={10} className="pulse" />
                        Speaking
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 10, opacity: 0.5 }}>#{idx + 1}</span>
                </div>

                <div style={{ fontSize: 13, lineHeight: 1.55 }}>
                  {turn.text}
                </div>

                {turn.citations && turn.citations.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <CitationSources citations={turn.citations} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Ask Hosts a Follow-up */}
        <div
          style={{
            borderTop: "1px solid var(--border-subtle, #333)",
            paddingTop: 10,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <input
            type="text"
            className="text-field"
            value={followUpQuery}
            onChange={(e) => setFollowUpQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleFollowUp();
              }
            }}
            placeholder="Ask Alex & Sam a follow-up question about this episode…"
            style={{ fontSize: 12, flex: 1 }}
          />
          <button
            className="primary"
            onClick={handleFollowUp}
            disabled={!followUpQuery.trim()}
            style={{ fontSize: 12, padding: "6px 12px", borderRadius: 6, display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}
            title="Ask the hosts in the chat"
          >
            <span>Ask Hosts</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
