// Composes an image-generation prompt for merchandise mockups.
//
// A merch shot is a small set of recurring decisions — who is wearing it,
// how they are posed, what the garment is, and what is printed on it — and
// describing all four in one free-text prompt tends to lose whichever the
// model decides to skip. Naming them separately keeps each one addressable,
// and lets the reference images be labelled rather than passed as an
// undifferentiated list.
//
// Fields map to reference images by role:
//
//   model   → the person wearing it
//   product → the blank garment
//   logo    → the artwork printed on it
//
// Pose is deliberately text-only and optional: the common case is "keep the
// pose from the model reference", which is expressed by leaving it blank.

/** Roles a reference image can play, in the order they are described. */
export const REFERENCE_ROLES = ['model', 'product', 'logo']

/**
 * How many reference images the composed prompt may carry.
 *
 * Matches the cap in ImageGenerationService. Several OpenRouter models accept
 * only one reference, so raising this needs a per-model capability check
 * rather than just a bigger number.
 */
export const MAX_REFERENCES = 4

/**
 * Values a model writes into a field when it means "not applicable".
 *
 * An LLM filling these fields does not leave one blank — it explains itself,
 * writing "none - it's a flag, not worn by a person" into `model`. Composed
 * naively that became "It is worn by none - it's a flag, not worn by a
 * person", which reads to an image model as an instruction to include a
 * person, and produced a flat product shot with the model silently dropped.
 */
const NEGATION_PATTERN = /^\s*(none|n\/?a|not applicable|no |nobody|no one|null|undefined|empty|-|—)\b/i

/**
 * Treat an explained "not applicable" as blank.
 *
 * Deliberately matched at the start only: "no one is wearing it" is a
 * negation, while "a runner with no shirt" is a real description that
 * happens to contain the word.
 */
function meaningful(value) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return ''
  if (NEGATION_PATTERN.test(trimmed)) return ''
  return trimmed
}

function describeRole(role) {
  switch (role) {
    case 'model':
      // Not "wearing": the same field covers a flag being held and a mug
      // being carried, and the narrower word steered the generator wrong.
      return 'the person who should appear with the item'
    case 'product':
      return 'the blank garment or product being sold'
    case 'logo':
      return 'the artwork or logo to place on the item'
    default:
      return 'additional reference'
  }
}

/**
 * Build the text prompt.
 *
 * Every clause is omitted when its field is blank, rather than emitted with a
 * placeholder — "worn by an unspecified model" steers the image as much as a
 * real description would, just in a direction nobody asked for.
 */
export function composeMerchPrompt({
  description = '',
  model = '',
  pose = '',
  product = '',
  logo = '',
} = {}, { hasModelReference = false } = {}) {
  const clauses = []

  const cleanModel = meaningful(model)
  const cleanPose = meaningful(pose)
  const cleanProduct = meaningful(product)
  const cleanLogo = meaningful(logo)
  const cleanDescription = meaningful(description)

  const subject = cleanProduct || 'the product'
  clauses.push(`A product photograph of ${subject}.`)

  // An uploaded model image is itself a request for a person, even when the
  // text field is blank — that is the whole point of attaching it. Without
  // this, the prompt captioned the reference but never asked for a person,
  // and "product photograph ... product clearly visible" pulled the result
  // toward a flat product shot with the reference ignored.
  if (cleanModel) {
    // "worn by" is wrong for anything not clothing — a flag or mug is held.
    // The generic phrasing covers both without classifying the product.
    clauses.push(`It is shown with ${cleanModel}.`)
  } else if (hasModelReference) {
    clauses.push('It is shown with the person from the reference image.')
  }
  if (cleanPose) {
    clauses.push(`Pose: ${cleanPose}.`)
  } else if (hasModelReference) {
    // Only say this when there is actually an image to inherit a pose from.
    // Referring to a reference image that was never supplied invites the
    // generator to invent one.
    clauses.push('Keep the pose and framing from the reference image.')
  }
  if (cleanLogo) {
    clauses.push(`Printed on the item: ${cleanLogo}.`)
  }
  if (cleanDescription) {
    clauses.push(cleanDescription)
  }

  // A person in the shot means it is a lifestyle photograph, not a cut-out.
  // Demanding a "plain uncluttered background" in that case fought the
  // reference image and helped produce a bare product on grey.
  const wantsPerson = Boolean(cleanModel) || hasModelReference
  clauses.push(
    wantsPerson
      ? 'Photorealistic lifestyle photograph, evenly lit, the person and the product both clearly visible and in focus.'
      : 'Photorealistic, evenly lit, plain uncluttered background, the product clearly visible and in focus.',
  )

  return clauses.join(' ')
}

/**
 * Order and cap reference images, and describe what each one is.
 *
 * Roles are emitted in REFERENCE_ROLES order so the caption list always lines
 * up with the image list — a model told "the second image is the logo" will
 * use the wrong picture if the order drifts.
 */
export function composeReferences(references = {}) {
  const ordered = []

  for (const role of REFERENCE_ROLES) {
    const entry = references[role]
    if (entry && entry.dataBase64 && entry.mimeType) {
      ordered.push({ role, ...entry })
    }
  }

  return ordered.slice(0, MAX_REFERENCES)
}

/**
 * Full prompt including a legend for the reference images.
 *
 * Without the legend the model receives several images and no indication of
 * which is the garment and which is the artwork.
 */
export function composeMerchRequest(fields = {}, references = {}) {
  const ordered = composeReferences(references)
  let prompt = composeMerchPrompt(fields, {
    hasModelReference: ordered.some((r) => r.role === 'model'),
  })

  if (ordered.length > 0) {
    const legend = ordered
      .map((ref, index) => `Image ${index + 1} is ${describeRole(ref.role)}.`)
      .join(' ')
    prompt = `${prompt} ${legend}`
  }

  return { prompt, inputs: ordered.map(({ mimeType, dataBase64 }) => ({ mimeType, dataBase64 })) }
}

/**
 * Prompt for revising an existing image.
 *
 * Image models do not edit in place: the previous image goes back in as a
 * reference and the whole picture is regenerated. So the prompt has to say
 * what to keep as well as what to change — asking only for the change tends
 * to produce a picture that satisfies the instruction and quietly drops
 * something that was right before. Moving a flag "to one side" without
 * saying "still held" returns a flag floating in mid-air.
 */
export function composeEditPrompt(instruction, { originalPrompt = '' } = {}) {
  const clean = String(instruction ?? '').trim()
  if (!clean) {
    throw new Error('An edit needs an instruction')
  }

  // Terminate the instruction so it does not run into the next sentence.
  // Without this the prompt read "...still held in his hand Keep everything
  // else exactly as it is", one garbled sentence in which the preservation
  // clause dominated and the requested change was largely ignored.
  const terminated = /[.!?]$/.test(clean) ? clean : `${clean}.`

  const clauses = [
    'Revise the attached image.',
    // Stated first and imperatively: the edit is the point of the request,
    // and burying it between framing sentences made it easy to drop.
    `Make this change: ${terminated}`,
    'This change must be clearly visible in the result.',
    // Pose, hands and body position are listed explicitly. An instruction
    // like "move the flag beside him" implies a different grip, and without
    // naming these the model rebuilt the whole stance — a two-armed overhead
    // display became a one-handed one at his side. Naming them keeps the
    // change local unless the instruction is genuinely about the pose.
    'Keep everything else exactly as it is — the same person, their pose, stance, '
      + 'facial expression, where their hands and arms are, the same product, '
      + 'artwork and any text on it, and the same framing, lighting, colours and style.',
    'Change only what was asked for, and change it as locally as possible: this is a '
      + 'retouch of the existing photograph, not a new photograph of the same subject.',
  ]

  // The original brief, when known, re-states the intent the edit must not
  // undo (a person holding the product, say).
  if (String(originalPrompt).trim()) {
    clauses.push(`The image was originally made for this brief, which still applies: ${String(originalPrompt).trim()}`)
  }

  return clauses.join(' ')
}
