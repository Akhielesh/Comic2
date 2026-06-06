import { describe, it, expect } from 'vitest';
import { scaffold } from './scaffold';
import type { CodeStudioArtifact, CodeStudioTemplate } from '../apiTypes';

const art = (
  files: { path: string; content: string }[],
  template: CodeStudioTemplate = 'react-ts'
): CodeStudioArtifact => ({
  title: 'Test App',
  template,
  files: files.map((f) => ({ ...f, language: 'typescript' })),
});

describe('scaffold — design stack support', () => {
  it('adds imported design deps (framer-motion, lucide-react) to package.json', () => {
    const { files } = scaffold(art([
      {
        path: '/App.tsx',
        content: `import { motion } from 'framer-motion';\nimport { Home } from 'lucide-react';\nexport default function App(){ return <motion.div><Home/></motion.div>; }`,
      },
    ]));
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.dependencies['framer-motion']).toBeDefined();
    expect(pkg.dependencies['lucide-react']).toBeDefined();
    expect(pkg.dependencies['react']).toBeDefined();
  });

  it('adds shadcn/ui Radix primitive imports as dependencies', () => {
    const { files } = scaffold(art([
      { path: '/App.tsx', content: `import * as Dialog from '@radix-ui/react-dialog';\nexport default () => null;` },
    ]));
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.dependencies['@radix-ui/react-dialog']).toBeDefined();
  });

  it('wires Tailwind + PostCSS when a CSS entry uses the @tailwind directives', () => {
    const { files } = scaffold(art([
      { path: '/App.tsx', content: `export default () => <div className="p-4" />;` },
      { path: '/index.css', content: `@tailwind base;\n@tailwind components;\n@tailwind utilities;` },
    ]));
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.devDependencies['tailwindcss']).toBeDefined();
    expect(pkg.devDependencies['autoprefixer']).toBeDefined();
    expect(files['postcss.config.js']).toContain('tailwindcss');
    expect(files['tailwind.config.js']).toContain('content');
    // the model's css moved under src/ and is imported by the generated entry.
    expect(files['src/index.css']).toContain('@tailwind');
    expect(files['src/main.tsx']).toContain("import './index.css'");
  });

  it('keeps a model-emitted tailwind.config at the project root (not under src/)', () => {
    const { files } = scaffold(art([
      { path: '/App.tsx', content: `export default () => null;` },
      { path: '/tailwind.config.js', content: `export default { content: ['./src/**/*'] };` },
      { path: '/index.css', content: `@tailwind base;` },
    ]));
    expect(files['tailwind.config.js']).toBeDefined();
    expect(files['src/tailwind.config.js']).toBeUndefined();
  });

  it('does NOT add Tailwind to a plain app that never opts in', () => {
    const { files } = scaffold(art([
      { path: '/App.tsx', content: `export default () => <div style={{ padding: 8 }} />;` },
    ]));
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.devDependencies?.tailwindcss).toBeUndefined();
    expect(files['tailwind.config.js']).toBeUndefined();
  });
});

describe('scaffold — Expo / React Native (web + mobile)', () => {
  const rnApp = `import { View, Text } from 'react-native';\nexport default function App(){ return <View><Text>Hi</Text></View>; }`;

  it('detects React Native and produces an Expo + react-native-web preview', () => {
    const { files, devCommand } = scaffold(art([{ path: '/App.tsx', content: rnApp }]));
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.dependencies['expo']).toBeDefined();
    expect(pkg.dependencies['react-native']).toBeDefined();
    expect(pkg.dependencies['react-native-web']).toBeDefined();
    expect(pkg.scripts.native).toContain('expo start');
    // Web preview is a plain Vite app, so it boots in the WebContainer like other web projects.
    expect(devCommand).toEqual(['npm', ['run', 'dev']]);
    expect(files['vite.config.js']).toContain("'react-native': 'react-native-web'");
    expect(files['web-entry.tsx']).toContain('AppRegistry');
    expect(files['app.json']).toContain('"expo"');
    expect(files['App.tsx']).toBe(rnApp);
  });

  it('keeps App + source at the project root so the Expo native entry resolves them', () => {
    const { files } = scaffold(art([{ path: '/App.tsx', content: rnApp }]));
    expect(files['App.tsx']).toBeDefined();
    expect(files['src/App.tsx']).toBeUndefined(); // NOT moved under src/ (would break expo/AppEntry)
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.main).toContain('expo/AppEntry');
  });

  it('wires NativeWind (babel/metro/tailwind/global.css) for the native build when imported', () => {
    const { files } = scaffold(art([
      { path: '/App.tsx', content: `import { cssInterop } from 'nativewind';\nimport { View } from 'react-native';\nexport default () => <View className="flex-1" />;` },
    ]));
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.dependencies.nativewind).toMatch(/4/);
    expect(pkg.devDependencies.tailwindcss).toBeDefined();
    expect(files['babel.config.js']).toContain('nativewind/babel');
    expect(files['metro.config.js']).toContain('withNativeWind');
    expect(files['tailwind.config.js']).toContain('nativewind/preset');
    expect(files['global.css']).toContain('@tailwind');
  });

  it('does NOT add NativeWind config to a plain (StyleSheet) RN app', () => {
    const { files } = scaffold(art([{ path: '/App.tsx', content: rnApp }]));
    expect(files['babel.config.js']).toBeUndefined();
    expect(files['metro.config.js']).toBeUndefined();
    expect(JSON.parse(files['package.json']).dependencies.nativewind).toBeUndefined();
  });

  it('adds imported, web-compatible RN libraries with Expo-aligned versions', () => {
    const { files } = scaffold(art([
      { path: '/App.tsx', content: `import { SafeAreaProvider } from 'react-native-safe-area-context';\n${rnApp}` },
    ]));
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.dependencies['react-native-safe-area-context']).toBeDefined();
  });

  it('detects Expo via app.json even without a react-native import', () => {
    const { files } = scaffold(art([
      { path: '/App.tsx', content: `export default () => null;` },
      { path: '/app.json', content: JSON.stringify({ expo: { name: 'x' } }) },
    ]));
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.dependencies['expo']).toBeDefined();
  });

  it('scaffolds a realistic multi-file Expo app into a coherent, runnable project', () => {
    const { files, installCommand, devCommand } = scaffold(art([
      { path: '/App.tsx', content: `import { NavigationContainer } from '@react-navigation/native';\nimport { SafeAreaProvider } from 'react-native-safe-area-context';\nimport Home from './screens/Home';\nexport default function App(){ return <SafeAreaProvider><NavigationContainer><Home/></NavigationContainer></SafeAreaProvider>; }` },
      { path: '/screens/Home.tsx', content: `import { View, Text, FlatList } from 'react-native';\nimport Card from '../components/Card';\nexport default function Home(){ return <View><Text>Home</Text><Card/></View>; }` },
      { path: '/components/Card.tsx', content: `import { View, Text } from 'react-native';\nexport default function Card(){ return <View><Text>Card</Text></View>; }` },
    ]));
    const pkg = JSON.parse(files['package.json']); // valid JSON
    expect(pkg.dependencies.expo).toBeDefined();
    expect(pkg.dependencies['react-native-safe-area-context']).toBeDefined();
    expect(pkg.dependencies['@react-navigation/native']).toBeDefined();
    // user tree preserved at root (no dangling relative imports; native + web share it)
    expect(files['App.tsx']).toContain('SafeAreaProvider');
    expect(files['screens/Home.tsx']).toContain('FlatList');
    expect(files['components/Card.tsx']).toContain('Card');
    // web preview wiring
    expect(files['vite.config.js']).toContain("'react-native': 'react-native-web'");
    expect(files['web-entry.tsx']).toContain("registerComponent('App'");
    expect(files['app.json']).toContain('"expo"');
    expect(installCommand).toEqual(['npm', ['install']]);
    expect(devCommand).toEqual(['npm', ['run', 'dev']]);
  });
});
