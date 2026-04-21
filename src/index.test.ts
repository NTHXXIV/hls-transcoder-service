import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { 
  toSecretKey
} from './shared/callback.js';
import {
  buildMasterPlaylist,
  VARIANT_CATALOG
} from './hls/index.js';
import { getVideoDuration, getContentType } from './shared/utils.js';
import { decrypt } from './shared/crypto.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

describe('Modular Utility Functions', () => {
  
  describe('getVideoDuration', () => {
    it('should return duration from ffprobe output', async () => {
      const mockChild = {
        stdout: {
          on: vi.fn((event, cb) => {
            if (event === 'data') cb(Buffer.from('123.456\n'));
          }),
        },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0);
        }),
      };
      (spawn as any).mockReturnValue(mockChild);

      const duration = await getVideoDuration('dummy.mp4');
      expect(duration).toBe(123.46); // Rounded to 2 decimals
    });
  });

  describe('toSecretKey', () => {
    it('should format callback client id correctly', () => {
      expect(toSecretKey('stagapps-sandbox')).toBe('HLS_CALLBACK_SECRET_STAGAPPS_SANDBOX');
    });
  });

  describe('buildMasterPlaylist', () => {
    it('should generate a valid m3u8 master playlist', () => {
      const variants = [VARIANT_CATALOG[0]!, VARIANT_CATALOG[1]!]; // 480p, 720p
      const playlist = buildMasterPlaylist(variants);
      
      expect(playlist).toContain('#EXTM3U');
      expect(playlist).toContain('NAME="480p"');
    });
  });

  describe('getContentType', () => {
    it('should return correct content types for HLS files', () => {
      expect(getContentType('video.m3u8')).toBe('application/vnd.apple.mpegurl');
    });
  });

  describe('decrypt', () => {
    it('should return raw value if no private key is provided', () => {
      expect(decrypt('some-encrypted-value', undefined)).toBe('some-encrypted-value');
    });
  });
});
