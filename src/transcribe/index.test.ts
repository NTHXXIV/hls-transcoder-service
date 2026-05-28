import { describe, it, expect } from 'vitest';
import { validatePayload } from './index.js';

describe('validatePayload', () => {

  it('throws if resource_id is missing', () => {
    expect(() => validatePayload({}, '--whisper')).toThrow("resource_id");
  });

  // whisper mode
  it('whisper: throws if source_url is missing', () => {
    expect(() => validatePayload({ resource_id: '123' }, '--whisper')).toThrow("source_url");
  });

  it('whisper: passes with source_url', () => {
    expect(() => validatePayload({ resource_id: '123', source_url: 'https://example.com/v.mp4' }, '--whisper')).not.toThrow();
  });

  // clean mode
  it('clean: throws if raw_url and raw are both missing', () => {
    expect(() => validatePayload({ resource_id: '123' }, '--clean')).toThrow("raw_url");
  });

  it('clean: passes with raw_url', () => {
    expect(() => validatePayload({ resource_id: '123', raw_url: 'https://example.com/raw.json' }, '--clean')).not.toThrow();
  });

  it('clean: passes with inline raw', () => {
    expect(() => validatePayload({ resource_id: '123', raw: { segments: [] } }, '--clean')).not.toThrow();
  });

  // summarize mode
  it('summarize: throws if clean_url is missing', () => {
    expect(() => validatePayload({ resource_id: '123' }, '--summarize')).toThrow("clean_url");
  });

  it('summarize: passes with clean_url', () => {
    expect(() => validatePayload({ resource_id: '123', clean_url: 'https://example.com/clean.json' }, '--summarize')).not.toThrow();
  });

});
