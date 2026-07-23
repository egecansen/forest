import { describe, expect, it } from 'vitest';
import {
  classifyTicket,
  resolveTestbox,
  type SrpReservation,
} from '../testbox-routing.js';

const held = (testbox: string, status = 'OK'): SrpReservation => ({ testbox, status });

describe('classifyTicket', () => {
  it('maps DEP- to preprod-dedicated and SHBDN- to dev-branch (case-insensitive)', () => {
    expect(classifyTicket('DEP-11495')).toBe('preprod-dedicated');
    expect(classifyTicket('dep-11495')).toBe('preprod-dedicated');
    expect(classifyTicket('SHBDN-253190')).toBe('dev-branch');
  });
  it('treats anything else / empty as unknown', () => {
    expect(classifyTicket('WEBT-1')).toBe('unknown');
    expect(classifyTicket('')).toBe('unknown');
    expect(classifyTicket(null)).toBe('unknown');
    expect(classifyTicket(undefined)).toBe('unknown');
  });
});

describe('resolveTestbox — operator override', () => {
  it('an explicit user testbox always wins, even for DEP-', () => {
    const r = resolveTestbox({
      jiraTicket: 'DEP-11495',
      reportTestboxes: [230, 230],
      userProvidedTestbox: 'tb161',
    });
    expect(r).toMatchObject({ status: 'resolved', testbox: 'tb161', id: 161, source: 'user' });
  });
  it('parses user box from xtbx / bare number forms', () => {
    expect(resolveTestbox({ userProvidedTestbox: 'xtbx215' })).toMatchObject({ testbox: 'tb215', id: 215 });
    expect(resolveTestbox({ userProvidedTestbox: 52 })).toMatchObject({ testbox: 'tb52', id: 52 });
  });
});

describe('resolveTestbox — DEP- (preprod dedicated)', () => {
  it('uses the mode of the report testboxes', () => {
    const r = resolveTestbox({ jiraTicket: 'DEP-11495', reportTestboxes: [230, 230, 161] });
    expect(r).toMatchObject({ status: 'resolved', testbox: 'tb230', id: 230, source: 'report-dedicated' });
  });
  it('is unresolved when the report carries no testbox', () => {
    const r = resolveTestbox({ jiraTicket: 'DEP-11495', reportTestboxes: [] });
    expect(r.status).toBe('unresolved');
  });
});

describe('resolveTestbox — SHBDN- (dev branch)', () => {
  it('uses a box the user already holds in SRP (status OK)', () => {
    const r = resolveTestbox({
      jiraTicket: 'SHBDN-253190',
      userReservations: [held('xtbx215'), held('xtbx51')],
    });
    expect(r).toMatchObject({ status: 'resolved', testbox: 'tb215', id: 215, source: 'srp-reservation' });
    expect(r).toMatchObject({ alternatives: ['tb51'] });
  });
  it('prefers a held box that also appears in the report', () => {
    const r = resolveTestbox({
      jiraTicket: 'SHBDN-1',
      reportTestboxes: [51],
      userReservations: [held('xtbx215'), held('xtbx51')],
    });
    expect(r).toMatchObject({ testbox: 'tb51', source: 'srp-reservation' });
  });
  it('ignores non-OK reservations', () => {
    const r = resolveTestbox({
      jiraTicket: 'SHBDN-1',
      userReservations: [held('xtbx215', 'EXPIRED'), held('xtbx99', 'PENDING')],
    });
    expect(r.status).toBe('needs-reservation');
  });
  it('needs a reservation when the user holds no OK box', () => {
    const r = resolveTestbox({ jiraTicket: 'SHBDN-253190', userReservations: [] });
    expect(r).toMatchObject({ status: 'needs-reservation', ticketClass: 'dev-branch' });
  });
});

describe('resolveTestbox — unknown ticket prefix', () => {
  it('prefers a held reservation', () => {
    const r = resolveTestbox({ jiraTicket: 'WEBT-9', userReservations: [held('xtbx7')] });
    expect(r).toMatchObject({ status: 'resolved', testbox: 'tb7', source: 'srp-reservation' });
  });
  it('falls back to the report box with a confirm note', () => {
    const r = resolveTestbox({ jiraTicket: 'WEBT-9', reportTestboxes: [88] });
    expect(r).toMatchObject({ status: 'resolved', testbox: 'tb88', source: 'report-dedicated' });
    expect((r as { note?: string }).note).toBeTruthy();
  });
  it('is unresolved with nothing to go on', () => {
    expect(resolveTestbox({}).status).toBe('unresolved');
  });
});
