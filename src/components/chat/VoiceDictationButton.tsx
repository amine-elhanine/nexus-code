import React, { useState, useEffect, useRef } from "react";
import { Mic, MicOff, Loader2 } from "lucide-react";

interface VoiceDictationButtonProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

export const VoiceDictationButton: React.FC<VoiceDictationButtonProps> = ({
  onTranscript,
  disabled = false,
}) => {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setIsSupported(false);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (event: any) => {
        let finalTranscript = "";
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript + " ";
          }
        }
        if (finalTranscript.trim()) {
          onTranscript(finalTranscript.trim());
        }
      };

      recognition.onerror = (err: any) => {
        console.warn("Speech recognition error:", err);
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    } catch {
      setIsSupported(false);
    }

    return () => {
      recognitionRef.current?.stop();
    };
  }, [onTranscript]);

  const toggleListening = () => {
    if (!isSupported || disabled) return;

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      try {
        recognitionRef.current?.start();
        setIsListening(true);
      } catch {
        setIsListening(false);
      }
    }
  };

  if (!isSupported) return null;

  return (
    <button
      type="button"
      className={`composer-tool-btn voice-btn ${isListening ? "listening" : ""}`}
      onClick={toggleListening}
      disabled={disabled}
      title={isListening ? "Listening... Click to stop dictation" : "Dictate prompt with voice"}
    >
      {isListening ? (
        <Mic size={14} className="text-rose-400 animate-pulse" />
      ) : (
        <Mic size={14} />
      )}
    </button>
  );
};
