import { describe, it, expect } from 'vitest';
import { buildAnswers } from '../question-logic';

const single = { question: 'A or B?', header: 'H', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false };
const multi = { question: 'Which?', header: 'H', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: true };

describe('buildAnswers', () => {
  it('maps single-select to a scalar label', () => {
    expect(buildAnswers([single], { 0: ['B'] }, {})).toEqual({ 'A or B?': 'B' });
  });
  it('maps multi-select to an array', () => {
    expect(buildAnswers([multi], { 0: ['X', 'Y'] }, {})).toEqual({ 'Which?': ['X', 'Y'] });
  });
  it('omits unanswered questions', () => {
    expect(buildAnswers([single], {}, {})).toEqual({});
  });
  it('defaults freeText to {} when omitted', () => {
    expect(buildAnswers([single], { 0: ['B'] })).toEqual({ 'A or B?': 'B' });
  });

  describe('free text', () => {
    it('single-select: free text alone answers the question', () => {
      expect(buildAnswers([single], {}, { 0: 'my own answer' })).toEqual({ 'A or B?': 'my own answer' });
    });
    it('single-select: free text takes priority over a picked option', () => {
      expect(buildAnswers([single], { 0: ['B'] }, { 0: 'my own answer' })).toEqual({ 'A or B?': 'my own answer' });
    });
    it('single-select: trims whitespace from free text', () => {
      expect(buildAnswers([single], {}, { 0: '  spaced out  ' })).toEqual({ 'A or B?': 'spaced out' });
    });
    it('single-select: whitespace-only free text is ignored, falls back to picked option', () => {
      expect(buildAnswers([single], { 0: ['B'] }, { 0: '   ' })).toEqual({ 'A or B?': 'B' });
    });
    it('single-select: empty free text and no pick omits the question', () => {
      expect(buildAnswers([single], {}, { 0: '' })).toEqual({});
    });
    it('multi-select: free text is appended to the picked labels', () => {
      expect(buildAnswers([multi], { 0: ['X'] }, { 0: 'extra' })).toEqual({ 'Which?': ['X', 'extra'] });
    });
    it('multi-select: free text alone (no picks) answers the question', () => {
      expect(buildAnswers([multi], {}, { 0: 'solo' })).toEqual({ 'Which?': ['solo'] });
    });
    it('multi-select: trims whitespace before appending', () => {
      expect(buildAnswers([multi], { 0: ['X'] }, { 0: '  extra  ' })).toEqual({ 'Which?': ['X', 'extra'] });
    });
    it('multi-select: whitespace-only free text is ignored', () => {
      expect(buildAnswers([multi], { 0: ['X'] }, { 0: '   ' })).toEqual({ 'Which?': ['X'] });
    });
    it('multi-select: no picks and no free text omits the question', () => {
      expect(buildAnswers([multi], {}, {})).toEqual({});
    });
  });
});
