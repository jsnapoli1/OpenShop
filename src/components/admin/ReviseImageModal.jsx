import { useState } from 'react'
import { Button } from '../ui/button'
import { adminApiRequest } from '../../lib/auth'
import { normalizeImageUrl } from '../../lib/utils'
import { X, Wand2 } from 'lucide-react'

/**
 * Revise a generated image by describing the change.
 *
 * Image models do not edit in place — the picture is regenerated with the
 * original as a reference — so the result is a *new* image rather than a
 * modified one. The before/after view makes that concrete, and the original
 * is never overwritten: a revision that goes wrong should not destroy the
 * image it was meant to improve.
 */
export function ReviseImageModal({ open, imageUrl, onClose, onApply }) {
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  if (!open) return null

  const source = result?.url || imageUrl

  async function revise() {
    if (!instruction.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await adminApiRequest('/api/admin/ai/edit-image', {
        method: 'POST',
        // Revise from the latest result when there is one, so repeated
        // rounds build on each other instead of restarting from the original.
        body: JSON.stringify({ url: source, instruction: instruction.trim() }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Could not revise the image')
      setResult(body)
      setInstruction('')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function close() {
    setInstruction('')
    setResult(null)
    setError(null)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Revise image"
    >
      <div
        className="relative mx-4 flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[var(--admin-border-primary)] bg-[var(--admin-bg-card)]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="absolute right-3 top-3 rounded-full border border-[var(--admin-border-primary)] bg-[var(--admin-bg-elevated)] p-2"
          onClick={close}
          aria-label="Close"
        >
          <X className="h-5 w-5 text-[var(--admin-text-secondary)]" />
        </button>

        <div className="flex-1 overflow-auto p-4">
          <h3 className="mb-3 text-base font-semibold text-[var(--admin-text-primary)]">
            Make image revisions
          </h3>

          {result ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <figure>
                <img
                  src={normalizeImageUrl(result.previousUrl || imageUrl)}
                  alt="Before"
                  className="block w-full rounded-md border border-[var(--admin-border-primary)] object-contain"
                />
                <figcaption className="mt-1 text-xs text-[var(--admin-text-muted)]">Before</figcaption>
              </figure>
              <figure>
                <img
                  src={normalizeImageUrl(result.url)}
                  alt="After"
                  className="block w-full rounded-md border border-[var(--admin-border-primary)] object-contain"
                />
                <figcaption className="mt-1 text-xs text-[var(--admin-text-muted)]">After</figcaption>
              </figure>
            </div>
          ) : (
            <img
              src={normalizeImageUrl(imageUrl)}
              alt="Image to revise"
              className="mx-auto block max-h-[45vh] object-contain"
            />
          )}
        </div>

        <div className="flex-shrink-0 space-y-3 border-t border-[var(--admin-border-primary)] p-4">
          <div>
            <label htmlFor="revise-instruction" className="block text-sm font-medium text-[var(--admin-text-primary)]">
              What should change?
            </label>
            <textarea
              id="revise-instruction"
              rows={2}
              value={instruction}
              disabled={busy}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Move the flag beside him so it does not cross his body, still held in his hand"
              className="mt-1 w-full resize-none rounded-md border border-[var(--admin-border-primary)] bg-[var(--admin-bg-elevated)] px-3 py-2 text-sm text-[var(--admin-text-primary)] placeholder:text-[var(--admin-text-muted)] disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-[var(--admin-text-muted)]">
              Describe only what to change — everything else is kept. The original
              image is not replaced.
            </p>
          </div>

          {error && <p role="alert" className="text-sm text-[var(--admin-error)]">{error}</p>}

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={revise} disabled={busy || !instruction.trim()}>
              <Wand2 className="mr-1.5 h-4 w-4" />
              {busy ? 'Revising…' : (result ? 'Revise again' : 'Revise')}
            </Button>
            {result && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onApply?.(result.url)
                  close()
                }}
              >
                Use this image
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default ReviseImageModal
