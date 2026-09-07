// Archiving placeholder ids must not reach Stripe, even with a real key set.
//
// A product created while the store had no STRIPE_SECRET_KEY carries the
// `prod_unlinked` / `price_unlinked` placeholders. Once a key is added, the
// delete route archives before removing the KV row — and archiving an id
// Stripe never issued 404s, so the throw left the product undeletable.
import { describe, it, expect } from 'vitest'
import {
  StripeService,
  UNLINKED_PRODUCT_ID,
  UNLINKED_PRICE_ID,
} from '../../../src/services/StripeService.js'

const REAL_KEY = 'sk_test_notasentinel'

/** Fails the test if any remote Stripe call is attempted. */
function forbidRemoteCalls(service) {
  const boom = () => {
    throw new Error('remote Stripe call attempted for a placeholder id')
  }
  service.stripe.products = { create: boom, update: boom }
  service.stripe.prices = { create: boom, update: boom }
}

describe('StripeService archiving of unlinked placeholders', () => {
  it('treats a real key as configured for remote sync', () => {
    const service = new StripeService(REAL_KEY, 'https://shop.example')
    expect(service.isConfigured).toBe(true)
    expect(service.skipsRemoteSync).toBe(false)
  })

  it('skips the remote call when archiving an unlinked product', async () => {
    const service = new StripeService(REAL_KEY, 'https://shop.example')
    forbidRemoteCalls(service)

    await expect(service.archiveProduct(UNLINKED_PRODUCT_ID)).resolves.toEqual({
      id: UNLINKED_PRODUCT_ID,
      active: false,
    })
  })

  it('skips the remote call when archiving an unlinked price', async () => {
    const service = new StripeService(REAL_KEY, 'https://shop.example')
    forbidRemoteCalls(service)

    await expect(service.archivePrice(UNLINKED_PRICE_ID)).resolves.toEqual({
      id: UNLINKED_PRICE_ID,
      active: false,
    })
  })

  it('still delegates to Stripe for a genuine id', async () => {
    const service = new StripeService(REAL_KEY, 'https://shop.example')
    const seen = []
    service.stripe.products = {
      update: async (id, params) => {
        seen.push([id, params])
        return { id, ...params }
      },
    }

    await service.archiveProduct('prod_real123')
    expect(seen).toEqual([['prod_real123', { active: false }]])
  })
})
