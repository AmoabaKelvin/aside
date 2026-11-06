import { providerName } from '../lib/format'
import type { Provider } from '../lib/types'

export function EmptyState({ provider, model, hasHistory }: { provider: Provider; model: string; hasHistory: boolean }) {
  return (
    <div className="empty">
      <div className="empty-title">Ask anything</div>
      <div className="empty-sub">
        <span className="provider-dot" data-provider={provider} />
        {providerName(provider)} {model}
      </div>
      <div className="empty-hints">
        {hasHistory && (
          <span>
            <kbd>⌘[</kbd> previous chats
          </span>
        )}
        <span>
          <kbd>⌘V</kbd> paste a screenshot
        </span>
      </div>
    </div>
  )
}
