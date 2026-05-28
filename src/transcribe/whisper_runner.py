import sys
import json
import os
from faster_whisper import WhisperModel

def merge_segments(segments, max_gap_s=0.5, max_duration_s=20.0):
    """Merge adjacent segments separated by short gaps into sentence-length chunks."""
    if not segments:
        return segments
    merged = []
    current = dict(segments[0])
    for seg in segments[1:]:
        gap = seg["start"] - current["end"]
        merged_duration = seg["end"] - current["start"]
        if gap <= max_gap_s and merged_duration <= max_duration_s:
            current["end"] = seg["end"]
            current["text"] = current["text"].rstrip() + " " + seg["text"].lstrip()
        else:
            merged.append(current)
            current = dict(seg)
    merged.append(current)
    return merged


def transcribe(audio_path, model_size="large-v3", initial_prompt=None):
    # Cấu hình tối ưu cho CPU GitHub Actions (2 vCPU)
    # cpu_threads=2 giúp tránh tranh chấp tài nguyên
    model = WhisperModel(
        model_size,
        device="cpu",
        compute_type="int8",
        cpu_threads=2,
        num_workers=1
    )

    # Bật tính năng log tiến độ ra stderr để Node.js bắt được
    segments, info = model.transcribe(
        audio_path,
        beam_size=5,
        initial_prompt=initial_prompt,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )

    print(f"DEBUG: Detected language {info.language} with probability {info.language_probability:.2f}", file=sys.stderr)

    raw_segments = []
    for segment in segments:
        # In tiến độ ra stderr để người dùng không cảm thấy bị kẹt
        percent = (segment.end / info.duration) * 100 if info.duration > 0 else 0
        print(f"PROGRESS: {percent:.1f}% transcribed ({segment.end:.1f}s / {info.duration:.1f}s)", file=sys.stderr)

        raw_segments.append({
            "start": round(segment.start, 2),
            "end": round(segment.end, 2),
            "text": segment.text.strip()
        })

    results = merge_segments(raw_segments)

    return {
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
        "segments": results,
        "full_text": " ".join([s["text"] for s in results])
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing audio path"}))
        sys.exit(1)
        
    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base"
    initial_prompt = sys.argv[3] if len(sys.argv) > 3 else None
    
    try:
        output = transcribe(audio_path, model_size, initial_prompt)
        # Kết quả JSON cuối cùng in ra stdout
        print(json.dumps(output, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
