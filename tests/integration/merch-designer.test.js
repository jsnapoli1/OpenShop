// Tests for the merch designer: prompt composition and the generate-and-store
// endpoint the agent calls.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createTestApp,
  createTestRequest,
  executeRequest,
  parseJsonResponse,
  createAdminToken,
  createAdminHeaders,
} from '../utils/test-helpers.js'
import { createMockEnv, createMockKV } from '../setup.js'
import {
  composeMerchPrompt,
  composeMerchRequest,
  composeReferences,
  composeEditPrompt,
} from '../../src/services/MerchPromptService.js'

vi.mock('stripe', () => ({
  default: vi.fn(() => ({
    products: { create: vi.fn(), update: vi.fn(), retrieve: vi.fn() },
    prices: { create: vi.fn(), update: vi.fn() },
  })),
}))

const PIXEL = 'iVBORw0KGgoAAAANSUhEUg=='
const ref = (mimeType = 'image/png') => ({ mimeType, dataBase64: PIXEL })

describe('Merch prompt composition', () => {
  it('names each field rather than merging them', () => {
    const prompt = composeMerchPrompt({
      product: 'a grey hoodie',
      model: 'a young woman',
      pose: 'arms crossed',
      logo: 'a mountain crest',
    })

    expect(prompt).toContain('a grey hoodie')
    expect(prompt).toContain('shown with a young woman')
    expect(prompt).toContain('Pose: arms crossed')
    expect(prompt).toContain('Printed on the item: a mountain crest')
  })

  it('keeps the reference pose when pose is blank and an image was supplied', () => {
    const prompt = composeMerchPrompt(
      { product: 'a tee', model: 'a man', pose: '' },
      { hasModelReference: true },
    )
    expect(prompt).toContain('Keep the pose and framing from the reference image')
  })

  it('does not mention a reference image when none was supplied', () => {
    // Referring to an image that does not exist invites the generator to
    // invent one.
    const prompt = composeMerchPrompt({ product: 'a tee', model: 'a man', pose: '' })
    expect(prompt).not.toContain('reference image')
  })

  it('treats an explained "not applicable" as blank', () => {
    // An LLM does not leave a field empty; it explains itself. Composed
    // naively this became "It is worn by none - it's a flag...".
    const prompt = composeMerchPrompt({
      product: 'a camp flag',
      model: "none — it's a flag, not worn by a person",
    })
    expect(prompt).not.toMatch(/shown with none/i)
    expect(prompt).not.toMatch(/not worn by a person/i)
  })

  it('asks for a person when a model image is attached but the field is blank', () => {
    // Uploading a model image is itself the request for a person.
    const { prompt } = composeMerchRequest(
      { product: 'a blue camp flag' },
      { model: ref() },
    )
    expect(prompt).toContain('the person from the reference image')
    expect(prompt).toContain('lifestyle photograph')
    expect(prompt).not.toContain('plain uncluttered background')
  })

  it('does not mention a pose when there is no model at all', () => {
    const prompt = composeMerchPrompt({ product: 'a tee' })
    expect(prompt).not.toContain('Keep the pose')
    expect(prompt).not.toContain('Pose:')
  })

  it('omits blank fields instead of describing them as unspecified', () => {
    const prompt = composeMerchPrompt({ product: 'a tee' })
    expect(prompt).not.toMatch(/worn by/i)
    expect(prompt).not.toMatch(/printed on/i)
    expect(prompt).not.toMatch(/undefined|unspecified/i)
  })

  it('orders references predictably and labels them', () => {
    // Deliberately out of order: the legend must match the image order.
    const { prompt, inputs } = composeMerchRequest(
      { product: 'a tee' },
      { logo: ref(), model: ref('image/jpeg') },
    )

    expect(inputs).toHaveLength(2)
    // model comes before logo in REFERENCE_ROLES
    expect(inputs[0].mimeType).toBe('image/jpeg')
    expect(prompt).toContain('Image 1 is the person who should appear with the item')
    expect(prompt).toContain('Image 2 is the brand mark')
  })

  it('treats the brand as a design brief when an artistic style is given', () => {
    // Without this the prompt said "Printed on the item: <logo>", which
    // produced a flat transfer of the existing mark onto a blank garment
    // rather than a designed garment graphic.
    const prompt = composeMerchPrompt({
      product: 'an oversized tee',
      logo: 'Blue Mountain Cross Country Camp',
      style: 'vintage screenprint, halftone texture',
    })
    expect(prompt).toMatch(/design an original garment graphic/i)
    expect(prompt).toMatch(/vintage screenprint/i)
    expect(prompt).toMatch(/do not paste the logo on unchanged/i)
    expect(prompt).not.toMatch(/printed on the item/i)
  })

  it('reproduces the mark as-is when no style is given', () => {
    // Reproducing a logo faithfully is still the right default.
    const prompt = composeMerchPrompt({ product: 'a tee', logo: 'the camp crest' })
    expect(prompt).toMatch(/printed on the item/i)
    expect(prompt).not.toMatch(/design an original/i)
  })

  it('uses a style reference image even when the style field is blank', () => {
    const { prompt } = composeMerchRequest(
      { product: 'a tee', logo: 'the camp crest' },
      { style: ref() },
    )
    expect(prompt).toMatch(/artistic style of the style reference image/i)
    expect(prompt).toMatch(/Image 1 is an artistic reference/i)
  })

  it('caps references at the generator limit', () => {
    const many = composeReferences({
      model: ref(), product: ref(), logo: ref(), style: ref(), extra: ref(), other: ref(),
    })
    // Only known roles are kept, and never more than the cap.
    expect(many.length).toBeLessThanOrEqual(4)
    expect(many.every((r) => ['model', 'product', 'logo', 'style'].includes(r.role))).toBe(true)
  })

  it('ignores a reference with no image data', () => {
    const { inputs } = composeMerchRequest({ product: 'a tee' }, { model: { mimeType: 'image/png' } })
    expect(inputs).toHaveLength(0)
  })
})

describe('Agent action summaries', () => {
  it('reports the created product, not undefined', async () => {
    // Regression: summarizeResult read result.body, but tool handlers return
    // { status, data }. Every summary said "undefined", which reads as a
    // failure even when the product was created correctly.
    const { summarizeResult } = await import('../../src/routes/admin/agent.js')

    const summary = summarizeResult(
      { tool: 'create_product', args: {} },
      { ok: true, data: { id: 'abc', name: 'Pine Tee' } },
    )
    expect(summary).toContain('Pine Tee')
    expect(summary).not.toContain('undefined')
  })
})

describe('POST /api/admin/ai/generate-merch-image', () => {
  let app
  let env
  let kv
  let adminToken

  beforeEach(async () => {
    app = await createTestApp()
    env = createMockEnv()
    kv = createMockKV()
    env.TEST_KV = kv
    adminToken = await createAdminToken(env, kv)
    vi.restoreAllMocks()
  })

  function generate(body) {
    return executeRequest(app, createTestRequest('/api/admin/ai/generate-merch-image', {
      method: 'POST',
      headers: createAdminHeaders(adminToken),
      body: JSON.stringify(body),
    }), env)
  }

  it('requires something to describe', async () => {
    const res = await generate({})
    expect(res.status).toBe(400)
  })

  it('reports a storage failure without blaming generation', async () => {
    env.GEMINI_API_KEY = 'k'
    delete env.IMAGES // no R2 bucket bound

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: PIXEL, mimeType: 'image/png' } }] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    const res = await generate({ product: 'a hoodie' })
    const body = await parseJsonResponse(res)

    // The distinction matters: retrying generation would cost money and fail
    // again for the same reason.
    expect(res.status).toBe(503)
    expect(body.error).toMatch(/could not be saved/i)
    expect(body.error).toMatch(/R2/i)
  })
})

describe('POST /api/admin/ai/edit-image', () => {
  let app
  let env
  let kv
  let adminToken

  beforeEach(async () => {
    app = await createTestApp()
    env = createMockEnv()
    kv = createMockKV()
    env.TEST_KV = kv
    adminToken = await createAdminToken(env, kv)
    vi.restoreAllMocks()
  })

  function edit(body) {
    return executeRequest(app, createTestRequest('/api/admin/ai/edit-image', {
      method: 'POST',
      headers: createAdminHeaders(adminToken),
      body: JSON.stringify(body),
    }), env)
  }

  it('needs both an image and an instruction', async () => {
    expect((await edit({ instruction: 'move it' })).status).toBe(400)
    expect((await edit({ url: '/api/images/x.png' })).status).toBe(400)
  })

  it('rejects a url outside the store\'s own images', async () => {
    // A caller-supplied path must not become a way to read arbitrary keys
    // or make the worker fetch a remote URL.
    for (const url of [
      'https://example.com/evil.png',
      '/api/images/../../secret',
      '/etc/passwd',
      '/api/admin/products',
    ]) {
      const res = await edit({ url, instruction: 'change it' })
      expect(res.status).toBe(400)
    }
  })

  it('preserves the rest of the image in the prompt it sends', () => {
    const prompt = composeEditPrompt('move the flag to his left')

    expect(prompt).toContain('move the flag to his left')
    // Asking only for the change tends to drop something that was right:
    // moving a flag "to one side" without "still held" returns it floating.
    expect(prompt).toMatch(/keep everything else/i)
  })

  it('carries the original brief forward so an edit cannot undo it', () => {
    const prompt = composeEditPrompt('move the flag', {
      originalPrompt: 'It is shown with the person from the reference image.',
    })
    expect(prompt).toContain('shown with the person from the reference image')
  })

  it('terminates the instruction so it does not run into the next sentence', () => {
    // Without this the prompt read "...still held in his hand Keep everything
    // else exactly as it is" — one garbled sentence in which the preservation
    // clause dominated and the requested change was largely ignored.
    const prompt = composeEditPrompt('move the flag beside him')
    expect(prompt).toContain('move the flag beside him.')
    expect(prompt).not.toMatch(/beside him Keep/)
  })

  it('does not double up terminating punctuation', () => {
    const prompt = composeEditPrompt('move the flag beside him.')
    expect(prompt).not.toContain('him..')
  })

  it('states the change imperatively so it is not treated as background', () => {
    const prompt = composeEditPrompt('make the background cream')
    expect(prompt).toMatch(/make this change/i)
    expect(prompt).toMatch(/clearly visible/i)
  })

  it('names pose and hands among what to preserve', () => {
    // "Move the flag beside him" implies a different grip. Without naming
    // these, the model rebuilt the whole stance rather than moving the flag.
    const prompt = composeEditPrompt('move the flag beside him')
    expect(prompt).toMatch(/pose/i)
    expect(prompt).toMatch(/hands and arms/i)
  })

  it('asks for a local retouch rather than a new photograph', () => {
    const prompt = composeEditPrompt('move the flag')
    expect(prompt).toMatch(/retouch/i)
    expect(prompt).toMatch(/as locally as possible/i)
  })

  it('protects text on the artwork from being redrawn', () => {
    // Each revision regenerates the image, so a wordmark erodes a little
    // every round — "Blue Mountain" came back as "Blue Montal".
    const prompt = composeEditPrompt('move the flag')
    expect(prompt).toMatch(/any text on it/i)
  })

  it('refuses an empty instruction', () => {
    expect(() => composeEditPrompt('   ')).toThrow(/instruction/i)
  })
})
