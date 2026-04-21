import sys
import json
from faster_whisper import WhisperModel

def transcribe(audio_path, model_size="base", initial_prompt=None):
    # Run on CPU with INT8 quantization for efficiency on GH Actions
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    
    segments, info = model.transcribe(
        audio_path, 
        beam_size=5, 
        initial_prompt=initial_prompt
    )
    
    results = []
    for segment in segments:
        results.append({
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip()
        })
        
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
        print(json.dumps(output, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
