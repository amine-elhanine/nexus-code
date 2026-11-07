# One-off: Phase 2.1 renderer — native MP3 playback branch for AudioPlayerModal.
p = 'src/components/notebook/AudioPlayerModal.tsx'
s = open(p, encoding='utf8').read()

# 1. Rename existing component; keep its body intact.
old_head = 'export function AudioPlayerModal({\n  audio,\n  onClose,\n  onAskFollowUp,\n}: {\n  audio: NotebookAudioOverview;\n  onClose: () => void;\n  onAskFollowUp?: (question: string) => void;\n}) {'
assert old_head in s, "component head"
new_head = 'function SpeechAudioPlayer({\n  audio,\n  onClose,\n  onAskFollowUp,\n}: {\n  audio: NotebookAudioOverview;\n  onClose: () => void;\n  onAskFollowUp?: (question: string) => void;\n}) {'
s = s.replace(old_head, new_head)

# 2. Distinct OS voices for the speechSynthesis fallback (Alex/Sam get two
# genuinely different voices instead of pitch-shifting one voice).
old_pitch = '''    // Set distinct pitch for Alex vs Sam
    if (turn.speaker === "Alex") {
      utterance.pitch = 1.05;
    } else {
      utterance.pitch = 0.88;
    }'''
assert old_pitch in s, "pitch block"
new_pitch = '''    // Distinct VOICES for Alex vs Sam (pitch shift is only the fallback
    // when the OS exposes fewer than two usable voices).
    const voices = window.speechSynthesis.getVoices();
    const usable = voices.filter((v) => /^en/i.test(v.lang) && !v.localService) .concat(voices.filter((v) => /^en/i.test(v.lang) && v.localService));
    const pool = usable.length >= 2 ? usable : voices;
    if (pool.length >= 2) {
      const assigned = turn.speaker === "Alex" ? pool[0] : pool[1 % pool.length];
      if (assigned) utterance.voice = assigned;
      utterance.pitch = turn.speaker === "Alex" ? 1.0 : 0.92;
    } else {
      utterance.pitch = turn.speaker === "Alex" ? 1.05 : 0.88;
    }'''
s = s.replace(old_pitch, new_pitch)

# 3. Wrapper + native player appended at the end of the file.
native = '''

// ── Native playback (synthesized neural episode) ────────────────────────────

function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function NativeAudioPlayer({
  audio,
  onClose,
  onAskFollowUp,
}: {
  audio: NotebookAudioOverview;
  onClose: () => void;
  onAskFollowUp?: (question: string) => void;
}) {
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState((audio.durationMinutes || 1) * 60_000);
  const [speed, setSpeed] = useState(1);
  const [copied, setCopied] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const api = (window as any).nexus;
        const payload = await api?.notebookAudioRead?.(audio.notebookId, audio.id);
        if (cancelled) return;
        if (!payload?.base64) {
          setLoadError("The audio file for this episode could not be loaded.");
          return;
        }
        const bytes = Uint8Array.from(atob(payload.base64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: payload.mimeType || "audio/mpeg" });
        revoke = URL.createObjectURL(blob);
        setSrcUrl(revoke);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
      setSrcUrl(null);
    };
  }, [audio.notebookId, audio.id]);

  // Active turn from the recorded per-turn timestamps.
  const timestamps = audio.turnTimestampsMs || [];
  const currentTurnIdx = (() => {
    let active = 0;
    for (let i = 0; i < timestamps.length; i++) if (currentTimeMs + 1 >= timestamps[i]) active = i;
    return active;
  })();

  // Keep the active turn scrolled into view.
  useEffect(() => {
    const el = transcriptRef.current?.querySelector(`#audio-turn-${currentTurnIdx}`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentTurnIdx]);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  };

  const jumpToTurn = (idx: number) => {
    const el = audioRef.current;
    if (!el || !timestamps[idx]) return;
    el.currentTime = timestamps[idx] / 1000;
    void el.play().catch(() => undefined);
  };

  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(audio.turns.map((t) => `${t.speaker}: ${t.text}`).join("\\n\\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const download = async () => {
    try {
      const api = (window as any).nexus;
      const saved = await api?.notebookAudioDownload?.(audio.notebookId, audio.id);
      if (saved) setSavedPath(saved);
    } catch { /* dialog unavailable */ }
  };

  const handleFollowUp = () => {
    const turn = audio.turns[currentTurnIdx];
    const question = followUpQuery.trim();
    if (!question || !turn) return;
    setFollowUpQuery("");
    onAskFollowUp?.(`Regarding what ${turn.speaker} said ("${turn.text.slice(0, 140)}…"): ${question}`);
  };

  const progressPercent = durationMs > 0 ? Math.min(100, Math.round((currentTimeMs / durationMs) * 100)) : 0;

  return (
    <Modal
      title={audio.title}
      subtitle={`Deep Dive Podcast · Neural audio${audio.audioModel ? ` (${audio.audioModel})` : ""} · ~${audio.durationMinutes} min · Alex & Sam`}
      onClose={onClose}
    >
      <div className="audio-overview-container" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
              disabled={!srcUrl}
              className="primary"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 20, fontSize: 12, cursor: "pointer" }}
              title={isPlaying ? "Pause episode" : "Play episode"}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
              <span>{isPlaying ? "Pause" : "Play Episode"}</span>
            </button>
            <span style={{ fontSize: 11, opacity: 0.8, fontVariantNumeric: "tabular-nums" }}>
              {formatClock(currentTimeMs)} / {formatClock(durationMs)} · Turn {currentTurnIdx + 1}/{audio.turns.length} ({progressPercent}%)
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
              <span style={{ opacity: 0.7 }}>Speed:</span>
              {[0.75, 1, 1.25, 1.5, 2].map((rate) => (
                <button
                  key={rate}
                  onClick={() => {
                    setSpeed(rate);
                    if (audioRef.current) audioRef.current.playbackRate = rate;
                  }}
                  style={{
                    padding: "2px 6px", fontSize: 10, borderRadius: 4,
                    border: "1px solid var(--border-subtle, #333)",
                    background: speed === rate ? "var(--accent, #3b82f6)" : "transparent",
                    color: speed === rate ? "#fff" : "inherit", cursor: "pointer",
                  }}
                >
                  {rate}x
                </button>
              ))}
            </div>
            <button
              onClick={download}
              disabled={!srcUrl}
              className="pane-action"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }}
              title="Save the MP3 episode to disk"
            >
              <Volume2 size={12} />
              <span>Download MP3</span>
            </button>
            <button onClick={copyTranscript} className="pane-action" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }} title="Copy full script to clipboard">
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? "Copied" : "Copy Script"}</span>
            </button>
          </div>
        </div>

        {loadError && (
          <div style={{ fontSize: 12, color: "#f87171", padding: "8px 12px", border: "1px solid rgba(248,113,113,0.3)", borderRadius: 8 }}>
            {loadError} — falling back to browser voices is available after reopening this episode.
          </div>
        )}
        {savedPath && (
          <div style={{ fontSize: 11, opacity: 0.8, padding: "6px 12px", border: "1px solid var(--border-subtle, #333)", borderRadius: 8 }}>
            Saved to {savedPath}
          </div>
        )}

        {srcUrl && (
          <input
            type="range"
            min={0}
            max={durationMs}
            value={currentTimeMs}
            onChange={(e) => {
              const el = audioRef.current;
              if (el) el.currentTime = Number(e.target.value) / 1000;
            }}
            style={{ width: "100%", accentColor: "var(--accent, #3b82f6)" }}
            aria-label="Seek"
          />
        )}
        {/* Hidden element drives playback; the range input is the visible seek bar. */}
        {srcUrl && (
          <audio
            ref={audioRef}
            src={srcUrl}
            preload="metadata"
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
            onLoadedMetadata={(e) => {
              const dur = e.currentTarget.duration;
              if (Number.isFinite(dur) && dur > 0) setDurationMs(Math.round(dur * 1000));
              e.currentTarget.playbackRate = speed;
            }}
            onTimeUpdate={(e) => setCurrentTimeMs(Math.round(e.currentTarget.currentTime * 1000))}
          />
        )}

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
                    padding: "3px 8px", fontSize: 11, whiteSpace: "nowrap", borderRadius: 12,
                    border: active ? "1px solid var(--accent, #3b82f6)" : "1px solid var(--border-subtle, #333)",
                    background: active ? "rgba(59, 130, 246, 0.15)" : "transparent",
                    color: active ? "var(--accent, #3b82f6)" : "inherit", cursor: "pointer",
                  }}
                >
                  {ch.title}
                </button>
              );
            })}
          </div>
        )}

        <div
          ref={transcriptRef}
          style={{ maxHeight: "52vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingRight: 4 }}
        >
          {audio.turns.map((turn, idx) => {
            const isTurnActive = idx === currentTurnIdx && isPlaying;
            const isAlex = turn.speaker === "Alex";
            const atMs = timestamps[idx];
            return (
              <div
                key={idx}
                id={`audio-turn-${idx}`}
                onClick={() => jumpToTurn(idx)}
                style={{
                  display: "flex", flexDirection: "column", gap: 4, padding: "10px 14px", borderRadius: 8,
                  borderLeft: isTurnActive
                    ? "3px solid var(--accent, #3b82f6)"
                    : isAlex ? "3px solid #60a5fa" : "3px solid #c084fc",
                  background: isTurnActive ? "rgba(59, 130, 246, 0.08)" : "var(--bg-elevated, #1c1c1c)",
                  cursor: "pointer", transition: "background 0.15s ease",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "1px 6px", borderRadius: 4,
                        background: isAlex ? "rgba(96, 165, 250, 0.2)" : "rgba(192, 132, 252, 0.2)",
                        color: isAlex ? "#93c5fd" : "#d8b4fe",
                      }}
                    >
                      {turn.speaker}
                    </span>
                    {typeof atMs === "number" && (
                      <span style={{ fontSize: 10, opacity: 0.5, fontVariantNumeric: "tabular-nums" }}>{formatClock(atMs)}</span>
                    )}
                    {isTurnActive && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--accent, #3b82f6)" }}>
                        <Radio size={10} className="pulse" />
                        Playing
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 10, opacity: 0.5 }}>#{idx + 1}</span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.55 }}>{turn.text}</div>
                {turn.citations && turn.citations.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <CitationSources citations={turn.citations} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ borderTop: "1px solid var(--border-subtle, #333)", paddingTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
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
            style={{ fontSize: 12, padding: "6px 12px", borderRadius: 6, cursor: "pointer" }}
            title="Ask the hosts in the chat"
          >
            <span>Ask Hosts</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function AudioPlayerModal(props: {
  audio: NotebookAudioOverview;
  onClose: () => void;
  onAskFollowUp?: (question: string) => void;
}) {
  // Synthesized neural episodes play the real MP3 with seek/download;
  // script-only overviews fall back to browser speech synthesis.
  if (props.audio.audioFilename) return <NativeAudioPlayer {...props} />;
  return <SpeechAudioPlayer {...props} />;
}
'''
s = s.rstrip() + '\n' + native
open(p, 'w', encoding='utf8', newline='\n').write(s)
print("player branch installed")
