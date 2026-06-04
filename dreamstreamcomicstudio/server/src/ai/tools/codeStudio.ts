// The `generate_app` tool — lets the AI emit a complete multi-file code project
// as a structured artifact instead of loose markdown code blocks. The client
// renders it in the interactive Code Studio panel (editor + live preview).

import type { ChatTool } from './types.js';
import type { CodeStudioArtifact, CodeStudioFile, CodeStudioTemplate } from '../../../../apiTypes.js';

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript',
  html: 'html', css: 'css', scss: 'css', less: 'css',
  json: 'json', md: 'markdown', mdx: 'markdown',
  py: 'python', go: 'go', rs: 'rust', rb: 'ruby',
  java: 'java', kt: 'kotlin', swift: 'swift',
  sh: 'shell', bash: 'shell', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', sql: 'sql', graphql: 'graphql',
};

const extToLanguage = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANG[ext] ?? ext;
};

const VALID_TEMPLATES: CodeStudioTemplate[] = ['react-ts', 'react', 'vanilla-ts', 'vanilla', 'static'];

export const generateAppTool: ChatTool = {
  name: 'generate_app',
  description: `Build a complete, runnable multi-file application or code project and open it in the live Code Studio panel. Use this tool whenever the user asks to build, create, scaffold, implement, or generate any app, component, game, tool, or significant block of executable code. Always emit ALL files with complete content — never truncate code, never write placeholder comments like "// add logic here". The result is instantly shown in an editable live preview the user can run and modify.`,
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short app name shown in the panel header, e.g. "Todo App" or "Conway\'s Game of Life".'
      },
      description: {
        type: 'string',
        description: 'One sentence describing what the app does (optional but helpful).'
      },
      template: {
        type: 'string',
        enum: ['react-ts', 'react', 'vanilla-ts', 'vanilla', 'static'],
        description: 'Framework template. react-ts = TypeScript + React, react = JavaScript + React, vanilla-ts = TypeScript without React, vanilla = plain JS/HTML/CSS, static = HTML + CSS only (no JS build step).'
      },
      files: {
        type: 'array',
        description: 'Every file that makes up the application. Include complete, working code in each file — no truncation, no TODOs, no placeholders. For React apps include at minimum /App.tsx (or /App.jsx) and the entry. For vanilla apps include /index.html.',
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path from project root with leading slash, e.g. "/App.tsx" or "/styles/main.css".'
            },
            content: {
              type: 'string',
              description: 'Full, complete file content. Never truncate or omit any code.'
            }
          },
          required: ['path', 'content']
        }
      }
    },
    required: ['title', 'template', 'files']
  },
  execute: async (args) => {
    const rawFiles = Array.isArray(args?.files)
      ? (args.files as { path: string; content: string }[])
      : [];

    if (!rawFiles.length) {
      return { content: 'generate_app requires at least one file in the files array.' };
    }

    const files: CodeStudioFile[] = rawFiles
      .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
      .slice(0, 50)
      .map((f) => ({
        path: f.path.startsWith('/') ? f.path : `/${f.path}`,
        content: f.content,
        language: extToLanguage(f.path)
      }));

    if (!files.length) {
      return { content: 'generate_app: no valid files provided. Each file must have a string path and string content.' };
    }

    const title =
      typeof args?.title === 'string' ? args.title.trim().slice(0, 100) : 'App';
    const description =
      typeof args?.description === 'string' ? args.description.trim().slice(0, 300) : undefined;
    const template: CodeStudioTemplate = VALID_TEMPLATES.includes(args?.template as CodeStudioTemplate)
      ? (args!.template as CodeStudioTemplate)
      : 'react-ts';

    const data: CodeStudioArtifact = { title, description, files, template };

    return {
      content: `Built "${title}" — ${files.length} file${files.length === 1 ? '' : 's'} (${template}). The Code Studio panel is now open with the live preview.`,
      artifacts: [{ type: 'code_studio', data }]
    };
  }
};
