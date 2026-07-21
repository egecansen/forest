import { describe, it, expect } from 'vitest';
import { buildAnswers } from '../question-logic';

const single = { question: 'A or B?', header: 'H', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false };
const multi = { question: 'Which?', header: 'H', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: true };

describe('buildAnswers', () => {
  it('maps single-select to a scalar label', () => {
    expect(buildAnswers([single], { 0: ['B'] })).toEqual({ 'A or B?': 'B' });
  });
  it('maps multi-select to an array', () => {
    expect(buildAnswers([multi], { 0: ['X', 'Y'] })).toEqual({ 'Which?': ['X', 'Y'] });
  });
  it('omits unanswered questions', () => {
    expect(buildAnswers([single], {})).toEqual({});
  });
});
