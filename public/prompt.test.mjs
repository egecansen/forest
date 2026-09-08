import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeTicketPrompt } from './prompt.js';

const JIRA = 'https://jira.sahibinden.com';

test('two tickets, one box: links joined by " - ", box last', () => {
  assert.equal(
    composeTicketPrompt({ tickets: ['SHBDN-232781', 'SHBDN-241011'], boxes: ['tb200'], jiraBaseUrl: JIRA }),
    'https://jira.sahibinden.com/browse/SHBDN-232781 - https://jira.sahibinden.com/browse/SHBDN-241011 - tb200',
  );
});

test('one ticket produces the same shape with a single link', () => {
  assert.equal(
    composeTicketPrompt({ tickets: ['SHBDN-253990'], boxes: ['tb161'], jiraBaseUrl: JIRA }),
    'https://jira.sahibinden.com/browse/SHBDN-253990 - tb161',
  );
});

test('several boxes join with " - " too', () => {
  assert.equal(
    composeTicketPrompt({ tickets: ['S-1'], boxes: ['tb161', 'tb230', 'tb7'], jiraBaseUrl: JIRA }),
    'https://jira.sahibinden.com/browse/S-1 - tb161 - tb230 - tb7',
  );
});

test('a trailing slash on jiraBaseUrl does not double up before /browse/', () => {
  assert.equal(
    composeTicketPrompt({ tickets: ['S-1'], boxes: ['tb1'], jiraBaseUrl: 'https://jira.sahibinden.com/' }),
    'https://jira.sahibinden.com/browse/S-1 - tb1',
  );
});

test('a missing jiraBaseUrl falls back to bare keys rather than an undefined/browse/... URL', () => {
  assert.equal(
    composeTicketPrompt({ tickets: ['SHBDN-1', 'SHBDN-2'], boxes: ['tb1'] }),
    'SHBDN-1 - SHBDN-2 - tb1',
  );
  assert.equal(
    composeTicketPrompt({ tickets: ['SHBDN-1'], boxes: ['tb1'], jiraBaseUrl: '' }),
    'SHBDN-1 - tb1',
  );
});

test('no tickets is an empty prompt — nothing to launch', () => {
  assert.equal(composeTicketPrompt({ tickets: [], boxes: ['tb1'], jiraBaseUrl: JIRA }), '');
  assert.equal(composeTicketPrompt(), '');
});

test('no boxes yet: the ticket link(s) alone, no trailing " - "', () => {
  assert.equal(
    composeTicketPrompt({ tickets: ['SHBDN-1'], boxes: [], jiraBaseUrl: JIRA }),
    'https://jira.sahibinden.com/browse/SHBDN-1',
  );
});

test('empty entries are dropped rather than rendered as blanks', () => {
  assert.equal(
    composeTicketPrompt({ tickets: ['A-1', '', null, 'A-2'], boxes: ['tb1', ''], jiraBaseUrl: JIRA }),
    'https://jira.sahibinden.com/browse/A-1 - https://jira.sahibinden.com/browse/A-2 - tb1',
  );
});
