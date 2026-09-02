// Admin AI routes (image generation).
//
// The provider is configurable: Gemini directly, or OpenRouter for access to
// other vendors' models under one key. See ImageGenerationService.
import { Hono } from 'hono'
import { asyncHandler } from '../../middleware/errorHandler.js'
import { ValidationError, APIError } from '../../utils/errors.js'
import { getKVNamespace } from '../../utils/kv.js'
import { resolveSetting } from '../../services/DeveloperSettingsService.js'
import {
  generateImage,
  ImageGenerationError,
} from '../../services/ImageGenerationService.js'
import { composeMerchRequest, composeEditPrompt } from '../../services/MerchPromptService.js'
import { R2Service } from '../../services/R2Service.js'
import { MediaService } from '../../services/MediaService.js'

const router = new Hono()

router.post('/generate-image', asyncHandler(async (c) => {
  const { prompt, inputs } = await c.req.json()

  if (!prompt || typeof prompt !== 'string') {
    throw new ValidationError('Missing prompt')
  }

  const kv = getKVNamespace(c.env)
  const [provider, geminiApiKey, openRouterApiKey, geminiModel, openRouterModel, siteUrl] =
    await Promise.all([
      resolveSetting(kv, c.env, 'IMAGE_PROVIDER'),
      resolveSetting(kv, c.env, 'GEMINI_API_KEY'),
      resolveSetting(kv, c.env, 'OPENROUTER_API_KEY'),
      resolveSetting(kv, c.env, 'GEMINI_IMAGE_MODEL'),
      resolveSetting(kv, c.env, 'OPENROUTER_IMAGE_MODEL'),
      resolveSetting(kv, c.env, 'SITE_URL'),
    ])

  try {
    const image = await generateImage({
      provider,
      geminiApiKey,
      openRouterApiKey,
      geminiModel,
      openRouterModel,
      prompt,
      inputs,
      siteUrl,
    })
    return c.json(image)
  } catch (error) {
    if (error instanceof ImageGenerationError) {
      throw new APIError(error.message, error.statusCode)
    }
    throw error
  }
}))

/**
 * Generate a merchandise mockup from labelled fields, store it, and return a
 * URL that can go straight onto a product.
 *
 * Separate from /generate-image because that one returns raw base64 for the
 * media picker to preview. Here the caller — the agent, usually — needs a
 * persisted URL, and making it round-trip base64 through the model's context
 * would be both slow and expensive.
 */
router.post('/generate-merch-image', asyncHandler(async (c) => {
  const body = await c.req.json()
  const { description, model, pose, product, logo, references } = body || {}

  if (!description && !product) {
    throw new ValidationError('Describe the product, or name it in the product field')
  }

  const { prompt, inputs } = composeMerchRequest(
    { description, model, pose, product, logo },
    references || {},
  )

  const kv = getKVNamespace(c.env)
  const [provider, geminiApiKey, openRouterApiKey, geminiModel, openRouterModel, siteUrl] =
    await Promise.all([
      resolveSetting(kv, c.env, 'IMAGE_PROVIDER'),
      resolveSetting(kv, c.env, 'GEMINI_API_KEY'),
      resolveSetting(kv, c.env, 'OPENROUTER_API_KEY'),
      resolveSetting(kv, c.env, 'GEMINI_IMAGE_MODEL'),
      resolveSetting(kv, c.env, 'OPENROUTER_IMAGE_MODEL'),
      resolveSetting(kv, c.env, 'SITE_URL'),
    ])

  let image
  try {
    image = await generateImage({
      provider,
      geminiApiKey,
      openRouterApiKey,
      geminiModel,
      openRouterModel,
      prompt,
      inputs,
      siteUrl,
    })
  } catch (error) {
    if (error instanceof ImageGenerationError) {
      throw new APIError(error.message, error.statusCode)
    }
    throw error
  }

  // Persist it. A generated image that only exists in a response body cannot
  // be attached to a product.
  const r2 = new R2Service(c.env)
  let stored
  try {
    stored = await r2.uploadFile(image.mimeType, image.dataBase64, 'merch-mockup.png')
  } catch (error) {
    // Worth naming precisely: the image generated fine, and only storage
    // failed. Without this the caller sees a generic 500 and retries the
    // expensive part.
    throw new APIError(
      `Image generated, but could not be saved: ${error?.message ?? error}. Check the R2 bucket binding.`,
      503,
    )
  }

  const url = stored.viewUrl || stored.downloadUrl
  await new MediaService(kv).createMediaItem({
    url,
    source: 'storage',
    filename: 'merch-mockup',
    mimeType: image.mimeType,
  }).catch((error) => {
    // A missing media-library entry is cosmetic; the URL still works.
    console.error('Generated image was stored but not added to the media library:', error)
  })

  return c.json({ url, mimeType: image.mimeType, prompt })
}))

/**
 * Revise an image that was already generated.
 *
 * Image models do not edit in place — the previous image is passed back as a
 * reference and the picture is regenerated — so this reads the stored bytes
 * rather than asking the caller to re-upload them. The agent only ever holds
 * a URL, and round-tripping the image through its context would be slow and
 * expensive.
 */
router.post('/edit-image', asyncHandler(async (c) => {
  const { url, instruction, originalPrompt } = await c.req.json()

  if (!url || typeof url !== 'string') {
    throw new ValidationError('Which image? Pass the url returned when it was generated.')
  }
  if (!instruction || typeof instruction !== 'string') {
    throw new ValidationError('Describe what to change')
  }

  // Only images this store generated. A caller-supplied path must not become
  // a way to read arbitrary keys, or to make the worker fetch a remote URL.
  const match = /^\/api\/images\/([\w.-]+)$/.exec(url.trim())
  if (!match) {
    throw new ValidationError('That does not look like an image this store generated')
  }

  const r2 = new R2Service(c.env)
  let object
  try {
    object = await r2.getFile(match[1])
  } catch (error) {
    throw new APIError(`Could not read the image: ${error?.message ?? error}`, 503)
  }
  if (!object) {
    throw new ValidationError('That image no longer exists')
  }

  const buffer = await object.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  // Chunked to keep the argument list within limits on large images.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  const dataBase64 = btoa(binary)
  const mimeType = object.httpMetadata?.contentType || 'image/png'

  const kv = getKVNamespace(c.env)
  const [provider, geminiApiKey, openRouterApiKey, geminiModel, openRouterModel, siteUrl] =
    await Promise.all([
      resolveSetting(kv, c.env, 'IMAGE_PROVIDER'),
      resolveSetting(kv, c.env, 'GEMINI_API_KEY'),
      resolveSetting(kv, c.env, 'OPENROUTER_API_KEY'),
      resolveSetting(kv, c.env, 'GEMINI_IMAGE_MODEL'),
      resolveSetting(kv, c.env, 'OPENROUTER_IMAGE_MODEL'),
      resolveSetting(kv, c.env, 'SITE_URL'),
    ])

  const prompt = composeEditPrompt(instruction, { originalPrompt })

  let image
  try {
    image = await generateImage({
      provider,
      geminiApiKey,
      openRouterApiKey,
      geminiModel,
      openRouterModel,
      prompt,
      inputs: [{ mimeType, dataBase64 }],
      siteUrl,
    })
  } catch (error) {
    if (error instanceof ImageGenerationError) {
      throw new APIError(error.message, error.statusCode)
    }
    throw error
  }

  // Stored as a new object rather than overwriting: the previous version may
  // already be attached to a product, and an edit that goes wrong should not
  // destroy the image it was meant to improve.
  let stored
  try {
    stored = await r2.uploadFile(image.mimeType, image.dataBase64, 'merch-mockup.png')
  } catch (error) {
    throw new APIError(
      `Image generated, but could not be saved: ${error?.message ?? error}. Check the R2 bucket binding.`,
      503,
    )
  }

  const newUrl = stored.viewUrl || stored.downloadUrl
  await new MediaService(kv).createMediaItem({
    url: newUrl,
    source: 'storage',
    filename: 'merch-mockup',
    mimeType: image.mimeType,
  }).catch((error) => {
    console.error('Edited image was stored but not added to the media library:', error)
  })

  return c.json({ url: newUrl, previousUrl: url.trim(), mimeType: image.mimeType, prompt })
}))

export default router
