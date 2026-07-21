import { describe, it, expect } from 'vitest';
import { filterDirs, pathSegments, pushRecent } from '../components/FolderPicker';

describe('filterDirs', () => {
  const dirs = [
    { name: 'Documents', path: '/Users/x/Documents' },
    { name: 'Downloads', path: '/Users/x/Downloads' },
    { name: 'src', path: '/Users/x/src' },
  ];

  it('returns everything for an empty query', () => {
    expect(filterDirs(dirs, '')).toEqual(dirs);
    expect(filterDirs(dirs, '   ')).toEqual(dirs);
  });

  it('filters case-insensitively by substring', () => {
    expect(filterDirs(dirs, 'do')).toEqual([dirs[0], dirs[1]]);
    expect(filterDirs(dirs, 'SRC')).toEqual([dirs[2]]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterDirs(dirs, 'zzz')).toEqual([]);
  });
});

describe('pathSegments', () => {
  it('splits an absolute path into ancestor-carrying segments', () => {
    expect(pathSegments('/Users/demo/projects')).toEqual([
      { label: '/', path: '/' },
      { label: 'Users', path: '/Users' },
      { label: 'demo', path: '/Users/demo' },
      { label: 'projects', path: '/Users/demo/projects' },
    ]);
  });

  it('handles the root path', () => {
    expect(pathSegments('/')).toEqual([{ label: '/', path: '/' }]);
  });

  it('returns an empty list for an empty path', () => {
    expect(pathSegments('')).toEqual([]);
  });
});

describe('pushRecent', () => {
  it('prepends a new path', () => {
    expect(pushRecent(['/a', '/b'], '/c')).toEqual(['/c', '/a', '/b']);
  });

  it('dedupes an existing path by moving it to the front', () => {
    expect(pushRecent(['/a', '/b', '/c'], '/b')).toEqual(['/b', '/a', '/c']);
  });

  it('caps the list at max (default 6)', () => {
    const list = ['/1', '/2', '/3', '/4', '/5', '/6'];
    expect(pushRecent(list, '/7')).toEqual(['/7', '/1', '/2', '/3', '/4', '/5']);
  });

  it('respects a custom max', () => {
    expect(pushRecent(['/a', '/b'], '/c', 2)).toEqual(['/c', '/a']);
  });
});


