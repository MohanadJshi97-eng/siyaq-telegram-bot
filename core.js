const VTT_CLOCK = /(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/;

export const MODES = new Set(["professional", "newsroom", "literal"]);

export function clampNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function validLanguageName(value) {
  const language = String(value || "").trim();
  return /^[\p{L}\p{M}][\p{L}\p{M}\s()\-]{0,49}$/u.test(language);
}

export function compactTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function subtitleTime(seconds, separator = ",") {
  const millis = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const secs = Math.floor((millis % 60_000) / 1000);
  const ms = millis % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${separator}${String(ms).padStart(3, "0")}`;
}

export function parseClock(value) {
  const match = String(value).trim().match(VTT_CLOCK);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const milliseconds = Number((match[4] || "0").padEnd(3, "0"));
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

export function parseVtt(vtt) {
  const lines = String(vtt || "").replaceAll("\r", "").split("\n");
  const segments = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes("-->")) continue;
    const [left, right] = lines[index].split("-->", 2);
    const start = parseClock(left);
    const end = parseClock(right.trim().split(/\s+/)[0]);
    if (start === null || end === null || end <= start) continue;
    const textLines = [];
    index += 1;
    while (index < lines.length && lines[index].trim()) {
      textLines.push(lines[index].trim());
      index += 1;
    }
    const text = textLines.join(" ").replace(/<[^>]+>/g, "").trim();
    if (text) segments.push({ start, end, text });
  }
  return segments;
}

function rawSegmentToTimed(segment, fallbackStart = 0) {
  if (!segment || typeof segment !== "object") return null;
  const text = String(segment.text ?? segment.transcript ?? segment.word ?? "").trim();
  if (!text) return null;
  const timestamp = Array.isArray(segment.timestamp) ? segment.timestamp : [];
  const start = Number(
    segment.start ?? segment.start_time ?? segment.startSecond ?? timestamp[0] ?? fallbackStart,
  );
  const end = Number(
    segment.end ?? segment.end_time ?? segment.endSecond ?? timestamp[1] ?? start + 5,
  );
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start: Math.max(0, start), end: Math.max(start + 0.05, end), text };
}

function sentencePieces(text) {
  const punctuation = String(text)
    .split(/(?<=[.!?؟؛。！？])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (punctuation.length > 1) return punctuation;
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const pieces = [];
  for (let start = 0; start < words.length; start += 24) {
    pieces.push(words.slice(start, start + 24).join(" "));
  }
  return pieces;
}

export function normalizeSegments(inputSegments, fallbackText = "", durationSeconds = 0) {
  const cleaned = [];
  let cursor = 0;
  for (const raw of Array.isArray(inputSegments) ? inputSegments : []) {
    const segment = rawSegmentToTimed(raw, cursor);
    if (!segment) continue;
    cursor = segment.end;
    cleaned.push(segment);
  }
  if (!cleaned.length && String(fallbackText).trim()) {
    cleaned.push({ start: 0, end: Math.max(1, Number(durationSeconds) || 5), text: String(fallbackText).trim() });
  }

  const result = [];
  for (const segment of cleaned) {
    const words = segment.text.split(/\s+/).filter(Boolean);
    const duration = segment.end - segment.start;
    if (words.length <= 30 && duration <= 16) {
      result.push(segment);
      continue;
    }
    const pieces = sentencePieces(segment.text);
    const totalWeight = pieces.reduce((sum, piece) => sum + Math.max(1, piece.length), 0);
    let pieceStart = segment.start;
    for (let index = 0; index < pieces.length; index += 1) {
      const isLast = index === pieces.length - 1;
      const share = Math.max(1, pieces[index].length) / totalWeight;
      const pieceEnd = isLast ? segment.end : Math.min(segment.end, pieceStart + duration * share);
      result.push({ start: pieceStart, end: Math.max(pieceStart + 0.05, pieceEnd), text: pieces[index] });
      pieceStart = pieceEnd;
    }
  }

  return result.map((segment, index) => ({ id: index + 1, ...segment }));
}

export function transcriptionToBlocks(result, durationSeconds = 0) {
  const value = result && typeof result === "object" ? result : {};
  let segments = Array.isArray(value.segments) ? value.segments : [];
  if (!segments.length && value.vtt) segments = parseVtt(value.vtt);
  const text = value.text ?? value.transcription ?? value.transcription_info?.text ?? "";
  return normalizeSegments(segments, text, durationSeconds);
}

function stripModelWrappers(value) {
  return String(value || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function extractModelText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  if (typeof result.response === "string") return result.response;
  if (result.response && typeof result.response === "object") return JSON.stringify(result.response);
  const choice = result.choices?.[0];
  return choice?.message?.content ?? choice?.text ?? result.text ?? "";
}

export function parseTranslationResult(result, expectedIds) {
  const raw = stripModelWrappers(extractModelText(result));
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        payload = JSON.parse(raw.slice(start, end + 1));
      } catch {
        payload = null;
      }
    }
  }

  const mapping = new Map();
  let rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.segments)
      ? payload.segments
      : Array.isArray(payload?.translations)
        ? payload.translations
        : [];
  if (!rows.length && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const numericEntries = Object.entries(payload).filter(([key]) => /^\d+$/.test(key));
    if (numericEntries.length) {
      rows = numericEntries.map(([id, translation]) => ({ id, translation }));
    }
  }
  for (const row of rows) {
    const id = Number(row?.id ?? row?.segment_id ?? row?.segmentId);
    const translation = String(
      row?.translation ?? row?.translated_text ?? row?.translatedText ?? row?.target ?? row?.text ?? "",
    ).trim();
    if (Number.isInteger(id) && translation) mapping.set(id, translation);
  }

  if (!mapping.size) {
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*(\d+)\s*(?:\t|\||:|—|-)\s*(.+?)\s*$/u);
      if (match) mapping.set(Number(match[1]), match[2].trim());
    }
  }

  const expected = expectedIds.map(Number);
  if (mapping.size === expected.length && expected.every((id) => mapping.has(id))) {
    return mapping;
  }

  const orderedTranslations = rows
    .map((row) =>
      String(
        row?.translation ?? row?.translated_text ?? row?.translatedText ?? row?.target ?? row?.text ?? "",
      ).trim(),
    )
    .filter(Boolean);
  if (orderedTranslations.length === expected.length) {
    return new Map(expected.map((id, index) => [id, orderedTranslations[index]]));
  }

  if (expected.length === 1) {
    if (mapping.size === 1) return new Map([[expected[0], [...mapping.values()][0]]]);
    const direct = String(typeof payload === "string" ? payload : raw)
      .replace(/^\s*(?:\d+\s*(?:\t|\||:|—|-)\s*)?/, "")
      .replace(/^(["'])|(["'])$/g, "")
      .trim();
    if (direct) return new Map([[expected[0], direct]]);
  }

  throw new Error(`TRANSLATION_MAPPING_MISMATCH expected=${expected.length} received=${mapping.size}`);
}

export function plainText(blocks, translated = true) {
  return blocks
    .map((block) => `(${compactTime(block.start)}) ${String(translated ? block.translation : block.text).trim()}`)
    .join("\n\n")
    .trim();
}

export function srtText(blocks, translated = true) {
  return blocks
    .map((block, index) => {
      const text = String(translated ? block.translation : block.text).trim();
      return `${index + 1}\n${subtitleTime(block.start)} --> ${subtitleTime(block.end)}\n${text}`;
    })
    .join("\n\n");
}

export function vttText(blocks, translated = true) {
  return `WEBVTT\n\n${blocks
    .map((block) => {
      const text = String(translated ? block.translation : block.text).trim();
      return `${subtitleTime(block.start, ".")} --> ${subtitleTime(block.end, ".")}\n${text}`;
    })
    .join("\n\n")}`;
}

export function splitTelegramText(text, limit = 3900) {
  const chunks = [];
  let remaining = String(text || "").trim();
  while (remaining.length > limit) {
    let boundary = remaining.lastIndexOf("\n\n", limit);
    if (boundary < limit / 3) boundary = remaining.lastIndexOf("\n", limit);
    if (boundary < limit / 3) boundary = remaining.lastIndexOf(" ", limit);
    if (boundary < 1) boundary = limit;
    chunks.push(remaining.slice(0, boundary).trimEnd());
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function safeFilename(value, fallback = "siyaq") {
  const cleaned = String(value || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function mimeForTranscription(mimeType, fileName) {
  const mime = String(mimeType || "").toLowerCase();
  const name = String(fileName || "").toLowerCase();
  if (mime.startsWith("audio/")) return mime;
  if (mime === "video/mp4" || name.endsWith(".mp4") || name.endsWith(".m4v")) return "audio/mp4";
  if (mime === "video/webm" || name.endsWith(".webm")) return "audio/webm";
  if (name.endsWith(".ogg") || name.endsWith(".oga")) return "audio/ogg";
  if (name.endsWith(".wav")) return "audio/wav";
  if (name.endsWith(".m4a")) return "audio/mp4";
  return "audio/mpeg";
}
