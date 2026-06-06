// Starter templates for Code Studio (Sprint 4, S4.1): a new user picks one and is one Build
// away from a running app. Each is a minimal but valid project (real Vite/npm where relevant).

import type { CodeStudioArtifact } from '../../../apiTypes';

export interface StarterTemplate {
  id: string;
  name: string;
  description: string;
  artifact: CodeStudioArtifact;
}

const PKG = (name: string, deps: Record<string, string>, devDeps: Record<string, string>) =>
  JSON.stringify({
    name, private: true, version: '0.0.0', type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: deps, devDependencies: devDeps,
  }, null, 2);

const REACT_DEPS = { react: '^18.3.1', 'react-dom': '^18.3.1' };
const REACT_DEV = { '@vitejs/plugin-react': '^4.3.1', typescript: '^5.5.0', vite: '^5.4.0', '@types/react': '^18.3.3', '@types/react-dom': '^18.3.0' };

/** Common Vite + React + TS scaffold; supply the App.tsx body. */
const reactScaffold = (name: string, appTsx: string): CodeStudioArtifact['files'] => [
  { path: '/package.json', content: PKG(name, REACT_DEPS, REACT_DEV) },
  { path: '/vite.config.ts', content: `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n` },
  { path: '/index.html', content: `<!doctype html>\n<html lang="en">\n  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${name}</title></head>\n  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>\n</html>\n` },
  { path: '/src/main.tsx', content: `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './styles.css';\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);\n` },
  { path: '/src/App.tsx', content: appTsx },
  { path: '/src/styles.css', content: `:root{font-family:Inter,system-ui,sans-serif}body{margin:0}\n.app{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;background:#0b0e14;color:#e2e8f0}\nbutton{font:inherit;padding:.6rem 1.1rem;border-radius:.6rem;border:2px solid #38bdf8;background:#11151f;color:#e2e8f0;cursor:pointer}\nbutton:hover{background:#0e1219}\n` },
];

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: 'counter',
    name: 'Counter',
    description: 'A tiny React + TypeScript counter — the classic starting point.',
    artifact: {
      title: 'Counter',
      template: 'react-ts',
      files: reactScaffold('counter', `import { useState } from 'react';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (\n    <div className="app">\n      <h1>Count: {count}</h1>\n      <button onClick={() => setCount((c) => c + 1)}>Increment</button>\n    </div>\n  );\n}\n`),
    },
  },
  {
    id: 'todo',
    name: 'Todo list',
    description: 'Add and check off tasks — local state, no backend.',
    artifact: {
      title: 'Todo list',
      template: 'react-ts',
      files: reactScaffold('todo', `import { useState } from 'react';\n\nexport default function App() {\n  const [items, setItems] = useState<{ text: string; done: boolean }[]>([]);\n  const [text, setText] = useState('');\n  const add = () => { if (text.trim()) { setItems((x) => [...x, { text: text.trim(), done: false }]); setText(''); } };\n  return (\n    <div className="app">\n      <h1>Todo</h1>\n      <div>\n        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Add a task" />\n        <button onClick={add}>Add</button>\n      </div>\n      <ul>\n        {items.map((it, i) => (\n          <li key={i} onClick={() => setItems((x) => x.map((y, j) => (j === i ? { ...y, done: !y.done } : y)))} style={{ textDecoration: it.done ? 'line-through' : 'none', cursor: 'pointer' }}>{it.text}</li>\n        ))}\n      </ul>\n    </div>\n  );\n}\n`),
    },
  },
  {
    id: 'py-api',
    name: 'Python API',
    description: 'A FastAPI service with /health + /items — run locally with uvicorn.',
    artifact: {
      title: 'Python API',
      template: 'static',
      files: [
        { path: '/main.py', content: `from fastapi import FastAPI\nfrom pydantic import BaseModel\n\napp = FastAPI(title="Items API")\n\n\nclass Item(BaseModel):\n    name: str\n    price: float\n\n\nitems: list[Item] = []\n\n\n@app.get("/health")\ndef health():\n    return {"status": "ok"}\n\n\n@app.get("/items")\ndef list_items():\n    return items\n\n\n@app.post("/items")\ndef add_item(item: Item):\n    items.append(item)\n    return item\n` },
        { path: '/requirements.txt', content: `fastapi==0.115.0\nuvicorn==0.30.6\n` },
        { path: '/README.md', content: `# Python API (FastAPI)\n\n## Run\n\n\`\`\`bash\npip install -r requirements.txt\nuvicorn main:app --reload\n\`\`\`\n\nOpen http://127.0.0.1:8000/docs for the interactive API explorer.\n` },
      ],
    },
  },
  {
    id: 'go-cli',
    name: 'Go CLI',
    description: 'A small Go command-line program — build and run with the Go toolchain.',
    artifact: {
      title: 'Go CLI',
      template: 'static',
      files: [
        { path: '/main.go', content: `package main\n\nimport (\n\t"bufio"\n\t"fmt"\n\t"os"\n\t"strings"\n)\n\nfunc main() {\n\tfmt.Print("What's your name? ")\n\tname, _ := bufio.NewReader(os.Stdin).ReadString('\\n')\n\tname = strings.TrimSpace(name)\n\tif name == "" {\n\t\tname = "world"\n\t}\n\tfmt.Printf("Hello, %s!\\n", name)\n}\n` },
        { path: '/go.mod', content: `module example.com/cli\n\ngo 1.22\n` },
        { path: '/README.md', content: `# Go CLI\n\n## Run\n\n\`\`\`bash\ngo run .\n\`\`\`\n\nBuild a binary: \`go build -o app .\`\n` },
      ],
    },
  },
  {
    id: 'landing',
    name: 'Landing page',
    description: 'A single-file HTML/CSS hero — no build step.',
    artifact: {
      title: 'Landing page',
      template: 'static',
      files: [
        { path: '/index.html', content: `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />\n<title>Launch</title>\n<style>\n  *{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;background:#0b0e14;color:#e2e8f0}\n  .hero{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:1rem;padding:2rem}\n  h1{font-size:clamp(2rem,6vw,4rem);margin:0;background:linear-gradient(100deg,#38bdf8,#a855f7);-webkit-background-clip:text;background-clip:text;color:transparent}\n  p{color:#94a3b8;max-width:32rem}\n  a{margin-top:1rem;padding:.7rem 1.4rem;border-radius:9999px;background:#38bdf8;color:#0b0e14;font-weight:700;text-decoration:none}\n</style>\n</head>\n<body>\n  <div class="hero">\n    <h1>Build something great</h1>\n    <p>This is your landing page. Edit index.html and press Build to see it live.</p>\n    <a href="#">Get started</a>\n  </div>\n</body>\n</html>\n` },
      ],
    },
  },
];
