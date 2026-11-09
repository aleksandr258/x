import { describe, expect, it } from 'vitest';
import { HandleParser } from '../../src/domain/services/handle-parser.js';

describe('HandleParser', () => {
  it('parses bare and @-prefixed handles and normalizes to lowercase', () => {
    expect(HandleParser.parse('BoredApeYC')).toEqual({
      ok: true,
      handle: 'boredapeyc',
    });
    expect(HandleParser.parse('  @Azuki_Official  ')).toEqual({
      ok: true,
      handle: 'azuki_official',
    });
  });

  it('parses x.com and twitter.com profile and status URLs', () => {
    expect(HandleParser.parse('https://x.com/PudgyPenguins')).toEqual({
      ok: true,
      handle: 'pudgypenguins',
    });
    expect(
      HandleParser.parse('https://twitter.com/BoredApeYC/status/189999?s=20&t=abc'),
    ).toEqual({
      ok: true,
      handle: 'boredapeyc',
    });
    expect(HandleParser.parse('mobile.twitter.com/@artblocks_io/with_replies')).toEqual({
      ok: true,
      handle: 'artblocks_io',
    });
    expect(HandleParser.parse('www.x.com/DeGodsNFT?ref=tg')).toEqual({
      ok: true,
      handle: 'degodsnft',
    });
  });

  it('rejects empty inputs, foreign domains, reserved routes, and invalid handles', () => {
    expect(HandleParser.parse('   ')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(HandleParser.parse('@')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(HandleParser.parse('https://x.com/')).toEqual({
      ok: false,
      reason: 'EMPTY',
    });

    expect(HandleParser.parse('https://instagram.com/boredapeyc')).toEqual({
      ok: false,
      reason: 'INVALID_DOMAIN',
    });

    for (const reserved of [
      'home',
      'explore',
      'search',
      'settings',
      'i',
      'intent',
      'share',
      'messages',
      'notifications',
      'compose',
      'tos',
      'privacy',
    ]) {
      expect(HandleParser.parse(`https://x.com/${reserved}`)).toEqual({
        ok: false,
        reason: 'RESERVED_ROUTE',
      });
    }

    expect(HandleParser.parse('@too_long_handle_16')).toEqual({
      ok: false,
      reason: 'INVALID_FORMAT',
    });
    expect(HandleParser.parse('@bad-dash')).toEqual({
      ok: false,
      reason: 'INVALID_FORMAT',
    });
  });

  it('recognizes direct chat @handle and X URLs while ignoring commands and normal sentences', () => {
    expect(HandleParser.parseDirectMessageInput('@azuki')).toEqual({
      ok: true,
      handle: 'azuki',
    });
    expect(HandleParser.parseDirectMessageInput('https://x.com/Azuki')).toEqual({
      ok: true,
      handle: 'azuki',
    });
    expect(HandleParser.parseDirectMessageInput('x.com/Azuki')).toEqual({
      ok: true,
      handle: 'azuki',
    });

    expect(HandleParser.parseDirectMessageInput('/start')).toBeNull();
    expect(HandleParser.parseDirectMessageInput('привет бот')).toBeNull();
    expect(HandleParser.parseDirectMessageInput('ok')).toBeNull();
  });
});
