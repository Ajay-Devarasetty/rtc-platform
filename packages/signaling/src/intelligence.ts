import { readFile } from "fs/promises";
import type { ServerMessage } from "@rtc/protocol";
import type { SignalingEnv } from "./env.js";
import { getRecording, updateRecordingIntelligence } from "./recordings.js";

export type DispatchFn = (appId: string, type: string, payload: Record<string, unknown>) => void;
export type SendToUserFn = (appId: string, userId: string, message: ServerMessage) => Promise<boolean>;

const DEMO_TRANSCRIPT =
  "[Demo transcript] Audio captured successfully. Set OPENAI_API_KEY on the signaling server for real speech-to-text.";
const DEMO_SUMMARY =
  "[Demo summary] Call recording saved. Enable OPENAI_API_KEY for AI-generated meeting notes.";

async function transcribeAudio(filePath: string, mimeType: string, apiKey: string | null) {
  if (!apiKey) return DEMO_TRANSCRIPT;

  const buffer = await readFile(filePath);
  const ext = mimeType.includes("video") ? "webm" : "webm";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), `recording.${ext}`);
  form.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Transcription failed: ${err}`);
  }

  const data = (await res.json()) as { text?: string };
  return data.text?.trim() || "";
}

async function summarizeTranscript(transcript: string, apiKey: string | null) {
  if (!apiKey) return DEMO_SUMMARY;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Summarize this call transcript in 2-4 concise sentences. Focus on decisions, action items, and key topics.",
        },
        { role: "user", content: transcript },
      ],
      max_tokens: 250,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Summary failed: ${err}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() || "";
}

export async function processRecordingIntelligence(
  recordingId: string,
  env: SignalingEnv,
  dispatch: DispatchFn,
  sendToUser: SendToUserFn
) {
  const recording = await getRecording(recordingId);
  if (!recording?.storagePath) return;

  const base = {
    recordingId,
    roomId: recording.roomId,
    callId: recording.callId || undefined,
    userId: recording.userId,
  };

  try {
    await updateRecordingIntelligence(recordingId, { intelligenceStatus: "processing" });

    const transcript = await transcribeAudio(
      recording.storagePath,
      recording.mimeType,
      env.openaiApiKey
    );
    await updateRecordingIntelligence(recordingId, {
      transcript,
      intelligenceStatus: "transcribed",
    });

    dispatch(recording.appId, "transcript.ready", { ...base, transcript });
    await sendToUser(recording.appId, recording.userId, {
      type: "transcript_ready",
      payload: { recordingId, roomId: recording.roomId, callId: recording.callId || undefined, transcript },
    });

    const summary = await summarizeTranscript(transcript, env.openaiApiKey);
    await updateRecordingIntelligence(recordingId, {
      summary,
      intelligenceStatus: "complete",
    });

    dispatch(recording.appId, "summary.ready", { ...base, transcript, summary });
    await sendToUser(recording.appId, recording.userId, {
      type: "summary_ready",
      payload: {
        recordingId,
        roomId: recording.roomId,
        callId: recording.callId || undefined,
        summary,
        transcript,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Intelligence processing failed";
    await updateRecordingIntelligence(recordingId, { intelligenceStatus: "failed" });
    console.error(`Recording intelligence failed (${recordingId}):`, message);
  }
}
