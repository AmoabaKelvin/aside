# Aside: how the panel and the Rust side fit together

Aside is a menu-bar-only Mac app (no Dock icon). A global shortcut (default `Cmd+Shift+Space`) shows a
tall chat panel over whatever app is in front. It answers with the user's own `claude` (Claude Code)
or `codex` CLI login. Conversations are kept as JSON in Aside's own folder, never in Claude Code's or
Codex's session history.

The types are in `src/lib/types.ts` and every command and event is wrapped in `src/lib/native.ts`.
Those two files are the contract. Change them only together with both sides.

## Files

`$DATA` = `~/Library/Application Support/com.kelvinamoaba.aside`

- `$DATA/settings.json` holds `Settings`. Missing fields take their defaults.
- `$DATA/conversations/<id>.json` holds one `Conversation`. The id is `YYYYMMDD-HHMMSS-xxxx` in local time, with 4 random hex characters.
- `$DATA/images/<sha256 first 16 hex>.<png|jpg|webp|gif>` holds images, named by content so repeats share a file.

Defaults: shortcut `Cmd+Shift+Space`, provider `claude`, claudeModel `sonnet`, claudeEffort `''`,
codexModel `''`, codexEffort `''`, webSearch `true`, freshAfterMinutes `10`, hideOnBlur `true`,
position `center`, instructions `''`, textSize `15`.

## The panel window

- There is one window, labelled `panel`. It's a non-activating `NSPanel` (tauri-nspanel, as in
  `../daybook/src-tauri/src/quick.rs`), created hidden at launch and kept around, so showing it is instant.
- It's transparent. The page draws the card. The window is the card plus a margin for its shadow:
  32px left and right, 24px at the top, 56px at the bottom. The card's shadow must fade out inside this margin, or the window edge clips it into a visible box.
- The card is 468px wide. Its height is 72% of the visible screen height, clamped to 520–780px.
  The window is sized once each time it's shown, and never while it's visible.
- `position: center` centres the card on the screen the pointer is on. `right` puts it 16px from that
  screen's right edge, centred vertically.

## Showing and hiding

- Shortcut while hidden: size, place, emit `aside://open {fresh}`, then show and make it key.
- Shortcut while visible: emit `aside://close`. The page animates out (about 120ms), then calls `hide_panel`.
  If the page doesn't call it within 400ms, the Rust side hides the panel anyway.
- When the panel resigns key (a click into another app), emit `aside://close`. This only happens
  if `hideOnBlur` is on and the panel isn't pinned.
- `fresh` is true when `freshAfterMinutes > 0`, no answer is streaming, and it's been at least that
  many minutes since the later of: the panel was last hidden, or the last answer finished.
- The tray menu has "Open Aside  ⌘⇧Space", "New chat", "Settings…" and "Quit Aside".
  - "New chat" opens with `fresh: true`.
  - "Settings…" opens the panel, then emits `aside://settings`.

## Streaming

- `send` saves the user message and an empty assistant message with status `streaming`, returns both,
  then streams on a background thread.
- It emits `aside://stream` events:
  - `text` events carry deltas, never the full text.
  - `thinking` means the model is reasoning before it answers. It can repeat.
  - `tool` is a web search or page fetch.
  - `done` carries the final, saved `AssistantMessage`.
- `stop` ends the stream. The message is saved with whatever text arrived and status `stopped`.
- Errors end with `done` and status `error`, plus a short, readable `error`.
- Several conversations can stream at once, so every event carries both ids.

## Keyboard (page side)

| Key | Action |
| --- | --- |
| `↵` | Send |
| `⇧↵` | New line |
| `Esc` | Close the image viewer or settings if one is open, otherwise hide the panel |
| `⌘[` / `⌘]` | Go to the previous (older) or next (newer) conversation. `⌘]` from the newest goes back to the clean slate |
| `⌘N` | New chat (clean slate) |
| `⌘.` | Stop the answer |
| `⌘,` | Settings |
| `⌘/` | Switch this chat between Claude and Codex |
| `⌘⇧C` | Copy the last answer |
| `⌘P` | Pin, so the panel stays up when you click elsewhere |
| `⌘V` | Paste text, or an image from the clipboard |
