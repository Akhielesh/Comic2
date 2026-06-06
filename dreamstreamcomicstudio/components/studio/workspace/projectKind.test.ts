import { describe, it, expect } from 'vitest';
import { detectProjectKind, projectKindLabel, isWebProject } from './projectKind';

const fp = (...paths: string[]) => paths.map((path) => ({ path }));

describe('detectProjectKind', () => {
  it('classifies a React app as web', () => {
    expect(detectProjectKind(fp('/App.tsx', '/package.json'))).toBe('web');
  });

  it('classifies a static HTML/CSS site as web', () => {
    expect(detectProjectKind(fp('/index.html', '/style.css'))).toBe('web');
  });

  it('classifies a Python project', () => {
    expect(detectProjectKind(fp('/main.py', '/requirements.txt', '/README.md'))).toBe('python');
  });

  it('classifies a Go project', () => {
    expect(detectProjectKind(fp('/main.go', '/go.mod'))).toBe('go');
  });

  it('web wins when both web and non-web files are present (e.g. a Node API with a frontend)', () => {
    expect(detectProjectKind(fp('/server.js', '/public/index.html', '/main.py'))).toBe('web');
  });

  it('picks the dominant non-web language', () => {
    expect(detectProjectKind(fp('/a.go', '/b.go', '/util.py'))).toBe('go');
  });

  it('falls back to other for unknown manifest-only sets', () => {
    expect(detectProjectKind(fp('/Makefile', '/notes.txt'))).toBe('other');
  });

  it('labels and web-check helpers behave', () => {
    expect(projectKindLabel('python')).toBe('Python');
    expect(isWebProject('web')).toBe(true);
    expect(isWebProject('go')).toBe(false);
  });
});
