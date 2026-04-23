import { describe, it, expect, vi } from 'vitest';
import { validatePayload } from './index.js';

describe('Transcription Job Logic', () => {
  
  it('should throw error if mandatory fields are missing', () => {
    const invalidPayload = { lesson_id: '123' };
    expect(() => validatePayload(invalidPayload)).toThrow("Missing mandatory fields");
  });

  it('should pass validation with all mandatory fields', () => {
    const validPayload = {
      lesson_id: '123',
      source_url: 'https://example.com/video.mp4',
      target_r2_config: {
        endpoint: 'https://xxx.r2.cloudflarestorage.com',
        bucket: 'test',
        prefix: 'lessons/123'
      }
    };
    expect(() => validatePayload(validPayload)).not.toThrow();
  });

});
