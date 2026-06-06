import { describe, it, expect } from 'vitest';
import { detectProjectKind, projectKindLabel, isWebProject, runHint } from './projectKind';

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

  it('detects a Node backend (Express dep + .listen) instead of mislabelling it web', () => {
    const files = [
      { path: '/server.js', content: "import express from 'express';\nconst app = express();\napp.listen(3000);" },
      { path: '/package.json', content: '{"dependencies":{"express":"^4.19.2"}}' },
      { path: '/README.md', content: '# api' },
    ];
    expect(detectProjectKind(files)).toBe('node');
  });

  it('keeps a vanilla browser JS app (with HTML) as web, not node', () => {
    const files = [
      { path: '/index.html', content: '<div id=app></div>' },
      { path: '/main.js', content: "document.getElementById('app').textContent = 'hi';" },
    ];
    expect(detectProjectKind(files)).toBe('web');
  });

  it('a bare .js file with no server signals stays web', () => {
    expect(detectProjectKind([{ path: '/main.js', content: 'console.log(1)' }])).toBe('web');
  });

  it('labels, web-check, and run hints behave', () => {
    expect(projectKindLabel('python')).toBe('Python');
    expect(projectKindLabel('node')).toBe('Node.js');
    expect(isWebProject('web')).toBe(true);
    expect(isWebProject('go')).toBe(false);
    expect(runHint('go')).toContain('go run');
    expect(runHint('web')).toBeNull();
  });
});
