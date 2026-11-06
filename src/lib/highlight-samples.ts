// Realistic code for warming each grammar at idle. JavaScriptCore compiles a grammar's regexes the first
// few times they run, which costs tens of milliseconds per construct. Doing that here, long before an
// answer streams, keeps streaming inside the frame budget. Loaded lazily, never in the main bundle.

const TS = `// A sample for warming the grammar.
import fs, { readFile } from 'node:fs/promises'
import type { Config } from './config'
export * from './util'

/** Doc comment with a {@link Thing} and @param x */
export interface Shape<T extends object = {}> extends Base { readonly id: string; size?: number; tags: T[]; fn(a: number): void }
export type Union = 'a' | 'b' | \`prefix-\${string}\` | { kind: 'x'; value: number[] } | null
enum Color { Red = 1, Green = 'g' }
declare module 'x' { export const y: number }

export default class Store<K, V> extends Map<K, V> implements Iterable<[K, V]> {
  static instance?: Store<string, number>
  #secret = 0
  private readonly items: Record<string, V> = {}
  constructor(public name: string, protected opts: Partial<Config> = {}) { super() }
  get doubled(): number { return this.size * 2 }
  @logged async load(path: string, retries = 3): Promise<V | undefined> {
    for (let i = 0; i < retries; i++) {
      try {
        const text = await readFile(path, 'utf8')
        const data = JSON.parse(text) as { items?: V[] }
        if (!data.items?.length) continue
        return data.items.find((item, idx) => idx > 0 && item !== null) ?? undefined
      } catch (error: unknown) {
        console.error(\`failed \${path}: \${(error as Error).message}\`, /\\d+\\.?\\d*/gi.test(path))
      } finally {
        this.#secret += 1
      }
    }
    switch (this.name) { case 'a': break; default: throw new Error('nope') }
  }
}

/* A block comment
   over two lines */
const handler = async ({ a, b: [c, ...rest] }: { a: number; b: number[] }, ...args: unknown[]): Promise<void> => {
  const obj = { a, c, nested: { deep: [1, 2.5, 0xff, 1_000n, -3e10] }, fn() { return this }, [\`k\${a}\`]: true }
  let x = a > 1 ? (c ?? 0) : rest.length >= 2 && !args ? void 0 : typeof a === 'number' ? a : 0
  x ||= 1; x &&= 2; x ??= 3
  return new Promise<void>((resolve) => setTimeout(resolve, x))
}
function* gen(): Generator<number> { yield* [1, 2] }
export const view = (props: { title: string }) => <div className="x" onClick={() => go(props.title)}>{props.title}</div>
`

const PYTHON = `"""Module docstring."""
from __future__ import annotations
import asyncio, json
from dataclasses import dataclass, field
from pathlib import Path

@dataclass(frozen=True)
class Item:
    name: str
    tags: list[str] = field(default_factory=list)
    score: float = 0.0

    def label(self) -> str:
        return f"{self.name} ({self.score:.2f})"

async def load(path: Path, *, retries: int = 3, **kw) -> dict[str, Item]:
    """Load items, retrying on errors."""
    for attempt in range(retries):
        try:
            with path.open() as fh:
                data = json.load(fh)
            return {k: Item(**v) for k, v in data.items() if v and not k.startswith("_")}
        except (OSError, ValueError) as error:  # retry
            await asyncio.sleep(0.2 * 2 ** attempt)
            last = error
        finally:
            pass
    raise RuntimeError(r"failed: \\d+") from last

if __name__ == "__main__":
    print(sorted([x for x in range(10) if x % 2 == 0], key=lambda n: -n), None, True)
`

const SHELL = `#!/usr/bin/env bash
set -euo pipefail
# Build and copy
export NAME="aside" VERSION=$(git describe --tags 2>/dev/null || echo "0.0.0")
for f in src/*.ts; do
  if [[ -f "$f" && ! "$f" =~ test ]]; then echo "found \${f##*/}"; fi
done
case "$1" in
  build) pnpm build && cp -r dist "$HOME/out" ;;
  *) echo "usage: $0 build" >&2; exit 1 ;;
esac
cat <<EOF > config.json
{ "name": "$NAME" }
EOF
ls -la | grep -v '^total' | awk '{ print $9 }' | sort -u
`

const RUST = `use std::collections::HashMap;
use std::error::Error;

/// A cache with a size limit.
#[derive(Debug, Clone, Default)]
pub struct Cache<K: Eq + std::hash::Hash, V> {
    items: HashMap<K, V>,
    limit: usize,
}

impl<K: Eq + std::hash::Hash + Clone, V> Cache<K, V> {
    pub fn new(limit: usize) -> Self { Self { items: HashMap::new(), limit } }
    pub fn get(&self, key: &K) -> Option<&V> { self.items.get(key) }
    pub async fn load(&mut self, key: K) -> Result<(), Box<dyn Error>> {
        let text = tokio::fs::read_to_string("x.json").await?;
        match text.len() { 0 => return Err("empty".into()), n if n > 10 => println!("{n}"), _ => {} }
        let v: Vec<u8> = vec![1, 2, 3];
        for (i, b) in v.iter().enumerate() { if *b > 1 && i != 0 { break; } }
        Ok(())
    }
}
// comment
fn main() { let mut c: Cache<String, i32> = Cache::new(10); c.items.insert("a".to_string(), 1); }
`

const GO = `package main

import (
	"context"
	"fmt"
	"net/http"
)

// Server handles requests.
type Server struct {
	addr string
	mux  *http.ServeMux
}

func (s *Server) Run(ctx context.Context) error {
	srv := &http.Server{Addr: s.addr, Handler: s.mux}
	go func() { <-ctx.Done(); _ = srv.Shutdown(context.Background()) }()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("serve: %w", err)
	}
	for i, v := range []int{1, 2, 3} { fmt.Println(i, v) }
	return nil
}
`

const SWIFT = `import SwiftUI

/// A row in the list.
struct Row: View, Identifiable {
    let id = UUID()
    @State private var expanded = false
    var title: String

    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(.headline)
            if expanded { Image(systemName: "chevron.down") }
        }
        .onTapGesture { withAnimation(.spring) { expanded.toggle() } }
    }

    func load() async throws -> [String] {
        guard let url = URL(string: "https://example.com") else { return [] }
        let (data, _) = try await URLSession.shared.data(from: url)
        return String(decoding: data, as: UTF8.self).split(separator: "\\n").map(String.init)
    }
}
`

const SQL = `-- Monthly totals
WITH monthly AS (
  SELECT date_trunc('month', created_at) AS month, SUM(amount)::numeric(10, 2) AS total
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  WHERE o.status IN ('paid', 'shipped') AND c.deleted_at IS NULL
  GROUP BY 1
)
SELECT month, total, LAG(total) OVER (ORDER BY month) AS previous
FROM monthly ORDER BY month DESC LIMIT 12;
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at);
UPDATE orders SET status = 'void' WHERE id = 42;
`

const CSS = `/* Card */
:root { --gap: 12px; color-scheme: light dark; }
.card:hover > .title, .card[data-open] { color: light-dark(#111, #eee); transform: translateY(-2px); }
@media (prefers-color-scheme: dark) { .card { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); } }
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: var(--gap); }
`

const HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Page</title><style>body { margin: 0 }</style></head>
  <body>
    <!-- comment -->
    <main id="app" class="wrap" data-x="1"><a href="/x?y=1&amp;z=2">Link</a></main>
    <script type="module">import { start } from './app.js'; start(document.querySelector('#app'))</script>
  </body>
</html>
`

const YAML = `# CI
name: build
on:
  push: { branches: [main] }
jobs:
  test:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          pnpm install
          pnpm test -- --reporter=dot
        env:
          CI: true
          RETRIES: 3
`

const TOML = `# Cargo
[package]
name = "aside"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
tokio = { version = "1.40", default-features = false }

[[bin]]
name = "aside"
path = "src/main.rs"
`

const JSON_SAMPLE = `{
  "name": "aside",
  "version": "0.1.0",
  "private": true,
  "scripts": { "dev": "vite", "build": "tsc -b && vite build" },
  "list": [1, 2.5, -3e2, true, false, null, "x\\"y"]
}
`

const MARKDOWN = `# Title

Some **bold**, *italic*, \`code\` and a [link](https://example.com).

- one
- two
  1. nested

> quote

| a | b |
| - | - |
| 1 | 2 |

\`\`\`ts
const x = 1
\`\`\`
`

const DIFF = `diff --git a/x.ts b/x.ts
index 1..2 100644
--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,4 @@ fn
 keep
-old
+new
+more
`

export const SAMPLES: Record<string, string> = {
  typescript: TS,
  tsx: TS,
  javascript: TS.replace(/: [A-Za-z<>[\]|' {};?,.()]+(?=[,)=])/g, ''),
  jsx: TS,
  json: JSON_SAMPLE,
  shellscript: SHELL,
  python: PYTHON,
  rust: RUST,
  go: GO,
  swift: SWIFT,
  sql: SQL,
  css: CSS,
  html: HTML,
  yaml: YAML,
  toml: TOML,
  markdown: MARKDOWN,
  diff: DIFF,
}
