// Which languages we highlight, what they're called, and how a fence's info string or a file path maps
// to one. No grammar code here: grammars load lazily inside the highlighting worker.

export const LANGUAGE_NAMES: Record<string, string> = {
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  jsx: 'JSX',
  json: 'JSON',
  jsonc: 'JSON',
  shellscript: 'Shell',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  swift: 'Swift',
  sql: 'SQL',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  yaml: 'YAML',
  toml: 'TOML',
  markdown: 'Markdown',
  diff: 'Diff',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  java: 'Java',
  kotlin: 'Kotlin',
  ruby: 'Ruby',
  php: 'PHP',
  lua: 'Lua',
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  graphql: 'GraphQL',
  xml: 'XML',
  ini: 'INI',
  powershell: 'PowerShell',
  r: 'R',
  scala: 'Scala',
  dart: 'Dart',
  elixir: 'Elixir',
  haskell: 'Haskell',
  zig: 'Zig',
  'objective-c': 'Objective-C',
  perl: 'Perl',
  hcl: 'HCL',
  nix: 'Nix',
  vue: 'Vue',
  svelte: 'Svelte',
  proto: 'Protobuf',
  dotenv: '.env',
  nginx: 'Nginx',
  regexp: 'Regex',
}

/** Loaded and warmed at startup, in the worker: what answers use most. */
export const CORE_LANGUAGES = ['typescript', 'tsx', 'javascript', 'jsx', 'json', 'shellscript', 'python', 'rust', 'go', 'swift', 'sql', 'css', 'html', 'yaml', 'toml', 'markdown', 'diff']

const ALIASES: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', shell: 'shellscript', console: 'shellscript', terminal: 'shellscript', fish: 'shellscript',
  py: 'python', python3: 'python', rs: 'rust', golang: 'go', yml: 'yaml', md: 'markdown', mdx: 'markdown',
  'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', h: 'c',
  cs: 'csharp', 'c#': 'csharp', kt: 'kotlin', kts: 'kotlin', rb: 'ruby', objc: 'objective-c', m: 'objective-c',
  docker: 'dockerfile', make: 'makefile', mk: 'makefile', gql: 'graphql', ps: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  tf: 'hcl', terraform: 'hcl', patch: 'diff', protobuf: 'proto', env: 'dotenv', json5: 'jsonc',
  htm: 'html', xhtml: 'html', svg: 'xml', plist: 'xml', cfg: 'ini', conf: 'ini', ex: 'elixir', exs: 'elixir', hs: 'haskell', pl: 'perl',
  regex: 'regexp', sc: 'scala',
}

const PLAIN = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'output', 'log'])

/** A language id we can highlight, from an info-string word, an alias or a file extension. */
export function resolveLang(word: string | undefined): string | null {
  const w = (word ?? '').trim().toLowerCase()
  if (PLAIN.has(w)) return null
  const id = ALIASES[w] ?? w
  return id in LANGUAGE_NAMES ? id : null
}

/** The language for a file path, by extension or by well-known name. */
export function langForPath(path: string): string | null {
  const base = path.split('/').pop() ?? ''
  if (/^dockerfile/i.test(base)) return 'dockerfile'
  if (/^(gnu)?makefile$/i.test(base)) return 'makefile'
  const ext = base.includes('.') ? base.split('.').pop() : ''
  return resolveLang(ext)
}

/** "TypeScript", not "ts". Unknown languages keep the word they were given. */
export function langLabel(word: string | undefined): string {
  const id = resolveLang(word)
  if (id) return LANGUAGE_NAMES[id]
  const w = (word ?? '').trim()
  return w && !PLAIN.has(w.toLowerCase()) ? w : 'Text'
}
