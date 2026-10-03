// Agents and skills catalog screens -- extracted out of main.ts (see
// docs/renderer-refactor-checklist.md, sub-project 4). Agents and skills
// are the same shape of screen (a list of existing user-created ones, each
// deletable, plus a form to create a new one) -- unified via
// openCatalogScreen's config object so labels/hints/delete-confirmation/
// etc. only need writing once instead of drifting between two
// near-duplicate functions.
import { api } from '../api'
import { renderSessionList } from './dashboard'

const app = document.getElementById('app')
if (!app) {
  throw new Error('Missing #app element')
}

interface CatalogEntry {
  name: string
  description: string
  path: string
  model?: string | null
  // Only agents set this (see AgentCatalogEntry) -- absent entirely for
  // skills, which don't themselves preload other skills.
  skills?: string[]
}

interface CatalogScreenConfig {
  title: string
  storageNote: string
  emptyMessage: string
  formHeading: string
  namePlaceholder: string
  nameHint: string
  bodyLabel: string
  bodyPlaceholder: string
  createdMessage: string
  updatedMessage: string
  deleteConfirm: (name: string) => string
  list: () => Promise<CatalogEntry[]>
  create: (name: string, description: string, body: string, model?: string, skills?: string[]) => Promise<void>
  remove: (path: string) => Promise<void>
  getBody: (path: string) => Promise<string>
  update: (name: string, description: string, body: string, model?: string, skills?: string[]) => Promise<void>
  // When set, shows a model selector in the form between description and
  // body -- only agents can pin a specific model to run on; skills omit
  // this entirely (no modelSelect gets created, and the option is simply
  // never offered).
  modelOptions?: { value: string; label: string }[]
  // When true, typing "@" in the body textarea opens a popup listing
  // this catalog's own entries (via `list()`) to reference by name --
  // e.g. an orchestrator agent's prompt naming the agents it delegates
  // to. Only agents set this; skills have no equivalent use case.
  enableMentions?: boolean
  // When set, typing "#" in the body textarea opens a popup listing
  // installed skills to preload into this agent's real `skills:`
  // frontmatter (see setupSkillPicker's own comment on why that's a
  // structured field, not text left in the prompt). Only agents set
  // this; a skill doesn't itself preload other skills.
  skillsField?: {
    listSkills: () => Promise<{ name: string; description: string }[]>
  }
  // When set, shows a small "install from GitHub" form above the
  // "create new" one -- only skills set this (via the third-party `npx
  // skills` tool; see installSkillFromGithub's own comment). Installing
  // just needs a source string; refreshList() picking it up afterward is
  // what makes it show up alongside a manually-created skill.
  installFromSource?: {
    heading: string
    placeholder: string
    hint: string
    buttonLabel: string
    installedMessage: string
    install: (source: string) => Promise<void>
  }
  // When set, an existing entry's edit form shows an "Archivos adjuntos"
  // section -- a way to bundle a real script alongside this entry (see
  // attachSkillFile's own comment), not just its own prompt/instructions
  // text. Only skills set this: an agent has no equivalent notion of
  // attached files today. Hidden entirely while creating a brand-new
  // entry (nothing to attach into until it's actually saved and has a
  // real path/directory).
  attachFile?: {
    listFiles: (path: string) => Promise<string[]>
    chooseFile: () => Promise<string | null>
    attach: (path: string, sourceFilePath: string) => Promise<string>
    remove: (path: string, fileName: string) => Promise<void>
  }
}

// Plain-textarea "@" autocomplete for referencing another catalog entry
// by name (e.g. an orchestrator agent's prompt naming which agents it
// delegates to). Deliberately much simpler than the terminal's
// createAtMentionInterceptor: this is a real DOM <textarea> with normal
// input events and a real caret index, not a raw byte stream into a pty,
// so there's no need to intercept keystrokes before they land -- react
// to what's already in the field instead.
//
// `getExcludedName` lets the caller keep an entry from suggesting
// itself (editing an agent's own prompt shouldn't offer to @-mention
// itself).
// Mirror-div trick: a hidden clone of the textarea, styled identically,
// holding the same text up to `index` plus a marker span right after --
// the marker's offset within that clone is where a caret at `index`
// would actually render inside the real textarea's content box.
const CARET_MIRROR_STYLE_PROPS = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'wordSpacing',
  'tabSize'
] as const

function getCaretPixelPosition(
  textarea: HTMLTextAreaElement,
  index: number
): { top: number; left: number; lineHeight: number } {
  const mirror = document.createElement('div')
  const style = getComputedStyle(textarea)
  for (const prop of CARET_MIRROR_STYLE_PROPS) {
    mirror.style[prop] = style[prop]
  }
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  mirror.style.height = 'auto'

  mirror.textContent = textarea.value.slice(0, index)
  const marker = document.createElement('span')
  // A real character (not an empty span) so it actually occupies a
  // position on the line instead of collapsing to the mirror's edge.
  marker.textContent = textarea.value.slice(index, index + 1) || '.'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)

  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
  const top = marker.offsetTop - textarea.scrollTop
  const left = marker.offsetLeft
  document.body.removeChild(mirror)

  return { top, left, lineHeight }
}

// Shared by setupMentionPicker ("@", inserts "@name " text into the
// body -- delegating an agent to another) and setupSkillPicker ("#",
// doesn't touch the body text at all -- see that function's own comment
// on why preloading a skill is a structured frontmatter field, not
// something typed into the prompt). Both are "type a trigger character,
// pick from a filtered popup" -- everything about *finding* that run of
// text, positioning the popup under it, filtering as you type, and
// keyboard/mouse selection is identical between them; only what
// selecting an entry actually *does* differs, which is exactly what
// `onSelect` exists to parameterize.
function setupTriggerPicker<T extends { name: string }>(
  textarea: HTMLTextAreaElement,
  wrapper: HTMLElement,
  trigger: string,
  getCandidates: () => Promise<T[]>,
  options: {
    emptyMessage: string
    getExcludedNames?: () => string[]
    onSelect: (entry: T, range: { start: number; end: number }) => void
  }
): void {
  let popup: HTMLDivElement | null = null
  let filtered: T[] = []
  let activeIndex = 0
  let currentQuery = ''
  let mentionStart = 0

  function closePopup(): void {
    popup?.remove()
    popup = null
    filtered = []
  }

  // Finds a "<trigger>query" run ending exactly at the caret, with the
  // trigger either at the start of the text or preceded by whitespace
  // (so "user@example.com" never triggers the "@" picker).
  function findMention(): { start: number; query: string } | null {
    const caret = textarea.selectionStart ?? 0
    const textBefore = textarea.value.slice(0, caret)
    const match = textBefore.match(new RegExp(`(?:^|\\s)(\\${trigger}[a-z0-9-]*)$`, 'i'))
    if (!match) return null
    const triggerText = match[1]
    return { start: caret - triggerText.length, query: triggerText.slice(1) }
  }

  function renderPopup(): void {
    if (!popup) {
      popup = document.createElement('div')
      // "form-" prefixed: the terminal's own createAtMentionInterceptor
      // already owns bare .mention-popup/.mention-popup-item (anchored
      // to the bottom of the terminal box) -- reusing those names here
      // merged both rulesets' declarations and collapsed this popup to
      // ~0 height, since the terminal's `bottom: 8px` was never
      // overridden by this one's `top: 100%`.
      popup.className = 'form-mention-popup'
      wrapper.appendChild(popup)
    }
    // Recomputed on every render, not just at creation -- mentionStart
    // only actually changes between renders when a genuinely new
    // trigger run starts (e.g. the user clicked elsewhere in the same
    // textarea without closing this popup first, then typed a fresh
    // trigger), and a one-time-only position left the popup stuck
    // wherever the first mention in this session began. Harmless the
    // rest of the time (arrow-key navigation doesn't move the caret --
    // see the preventDefault calls below -- so mentionStart is frozen
    // and this resolves to the same spot every time).
    const caret = getCaretPixelPosition(textarea, mentionStart)
    popup.style.top = `${caret.top + caret.lineHeight}px`
    popup.style.left = `${caret.left}px`
    popup.innerHTML = ''

    // Same "<trigger>query" header the terminal's own mention popup
    // shows, so it's clear what's being matched -- reuses that popup's
    // own classes (mention-popup-query/-empty) since neither sets
    // position, so there's no repeat of the top/bottom collision this
    // form's outer .form-mention-popup avoided by not sharing that name.
    const queryEl = document.createElement('div')
    queryEl.className = 'mention-popup-query'
    queryEl.textContent = `${trigger}${currentQuery}`
    popup.appendChild(queryEl)

    if (filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'mention-popup-empty'
      empty.textContent = options.emptyMessage
      popup.appendChild(empty)
      return
    }

    filtered.forEach((entry, index) => {
      const item = document.createElement('div')
      item.className = 'form-mention-popup-item' + (index === activeIndex ? ' active' : '')
      // Plain one-line name, no description -- matches the terminal's
      // own mention popup exactly (a name-only list), per feedback that
      // the earlier name+description card style looked out of place
      // next to it.
      item.textContent = entry.name
      // mousedown (not click) so this fires before the textarea's blur
      // handler would otherwise close the popup first.
      item.addEventListener('mousedown', (event) => {
        event.preventDefault()
        selectEntry(entry)
      })
      popup!.appendChild(item)
    })
  }

  function selectEntry(entry: T): void {
    const mention = findMention()
    if (!mention) return
    const caret = textarea.selectionStart ?? 0
    options.onSelect(entry, { start: mention.start, end: caret })
    closePopup()
  }

  textarea.addEventListener('input', async () => {
    const mention = findMention()
    if (!mention) {
      closePopup()
      return
    }
    let candidates: T[]
    try {
      candidates = await getCandidates()
    } catch {
      candidates = []
    }
    // The mention could have been cancelled (popup closed, field
    // cleared) while getCandidates() was awaiting.
    if (!findMention()) return
    const excluded = options.getExcludedNames?.() ?? []
    currentQuery = mention.query
    mentionStart = mention.start
    const query = mention.query.toLowerCase()
    filtered = candidates
      .filter((entry) => !excluded.includes(entry.name))
      .filter((entry) => entry.name.toLowerCase().includes(query))
    activeIndex = 0
    // Stays open even with zero matches (showing the empty message)
    // instead of vanishing -- same feedback the terminal's own mention
    // popup gives, so typing a typo doesn't look like nothing happened.
    renderPopup()
  })

  textarea.addEventListener('keydown', (event) => {
    if (!popup) return
    if (event.key === 'Escape') {
      closePopup()
      return
    }
    if (filtered.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      activeIndex = (activeIndex + 1) % filtered.length
      renderPopup()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      activeIndex = (activeIndex - 1 + filtered.length) % filtered.length
      renderPopup()
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      selectEntry(filtered[activeIndex])
    }
  })

  // A plain blur (e.g. Tab-ing to the next field) should close the
  // popup too, but only after giving a pending mousedown-on-item enough
  // time to run first (see the mousedown-vs-click comment above).
  textarea.addEventListener('blur', () => {
    setTimeout(closePopup, 150)
  })
}

function setupMentionPicker(
  textarea: HTMLTextAreaElement,
  wrapper: HTMLElement,
  getCandidates: () => Promise<CatalogEntry[]>,
  getExcludedName: () => string | null
): void {
  setupTriggerPicker(textarea, wrapper, '@', getCandidates, {
    emptyMessage: 'Sin agentes que coincidan',
    getExcludedNames: () => {
      const excluded = getExcludedName()
      return excluded ? [excluded] : []
    },
    onSelect: (entry, { start, end }) => {
      const before = textarea.value.slice(0, start)
      const after = textarea.value.slice(end)
      const insertion = `@${entry.name} `
      textarea.value = before + insertion + after
      const newCaret = before.length + insertion.length
      textarea.focus()
      textarea.setSelectionRange(newCaret, newCaret)
    }
  })
}

// Unlike "@" (which delegates to another agent purely by naming it in
// the prompt text Claude reads -- that mention IS the whole mechanism),
// picking a skill here has no special effect on its own: preloading one
// is a real, structured `skills:` frontmatter field (see
// skillsFrontmatterBlock in agents.ts and the sub-agents docs it's based
// on), written separately from the prompt body entirely. The
// "#skill-name" text this still inserts into the body is purely for a
// human re-reading the prompt later to see what's referenced where --
// at direct request, after an earlier version that stripped it back out
// left no visible trace of the pick at all. `onPickSkill` is what
// actually does the thing that matters: adding it to the form's real
// skills list (shown as a removable chip, and written to frontmatter on
// save).
function setupSkillPicker(
  textarea: HTMLTextAreaElement,
  wrapper: HTMLElement,
  getCandidates: () => Promise<{ name: string; description: string }[]>,
  getSelectedNames: () => string[],
  onPickSkill: (skillName: string) => void
): void {
  setupTriggerPicker(textarea, wrapper, '#', getCandidates, {
    emptyMessage: 'Sin skills que coincidan',
    // Already-selected skills don't need offering again -- there's
    // nothing "#" would do for one that isn't already covered (removing
    // one is the chip's own "×", not a second "#" pick).
    getExcludedNames: getSelectedNames,
    onSelect: (entry, { start, end }) => {
      const before = textarea.value.slice(0, start)
      const after = textarea.value.slice(end)
      const insertion = `#${entry.name} `
      textarea.value = before + insertion + after
      const newCaret = before.length + insertion.length
      textarea.focus()
      textarea.setSelectionRange(newCaret, newCaret)
      onPickSkill(entry.name)
    }
  })
}

async function openCatalogScreen(config: CatalogScreenConfig): Promise<void> {
  app.innerHTML = ''

  const backButton = document.createElement('button')
  backButton.textContent = '← Back'
  backButton.addEventListener('click', renderSessionList)
  app.appendChild(backButton)

  const heading = document.createElement('h2')
  heading.textContent = config.title
  app.appendChild(heading)

  const storageNote = document.createElement('p')
  storageNote.className = 'cwd'
  storageNote.textContent = config.storageNote
  app.appendChild(storageNote)

  // The list is the actual reason anyone visits this screen most of the
  // time -- "create new" and (for skills) "install from GitHub" used to
  // sit above it as always-open forms, pushing it below the fold. Both
  // are modals now, opened from this small toolbar instead.
  const toolbar = document.createElement('div')
  toolbar.className = 'room-toolbar'
  app.appendChild(toolbar)

  const newButton = document.createElement('button')
  newButton.textContent = config.formHeading
  toolbar.appendChild(newButton)

  let installButton: HTMLButtonElement | null = null
  if (config.installFromSource) {
    installButton = document.createElement('button')
    installButton.textContent = config.installFromSource.heading
    toolbar.appendChild(installButton)
  }

  const list = document.createElement('div')
  list.className = 'roster-list'
  app.appendChild(list)

  // ── "Install from GitHub" modal (skills only) ───────────────────────
  if (config.installFromSource && installButton) {
    const installConfig = config.installFromSource

    const installBackdrop = document.createElement('div')
    installBackdrop.className = 'modal-backdrop'
    installBackdrop.hidden = true
    app.appendChild(installBackdrop)

    const installDialog = document.createElement('div')
    installDialog.className = 'modal-dialog'
    installBackdrop.appendChild(installDialog)

    const installHeader = document.createElement('div')
    installHeader.className = 'modal-dialog-header'
    installDialog.appendChild(installHeader)

    const installHeading = document.createElement('h3')
    installHeading.textContent = installConfig.heading
    installHeader.appendChild(installHeading)

    const installCloseButton = document.createElement('button')
    installCloseButton.className = 'modal-close'
    installCloseButton.textContent = '×'
    installCloseButton.title = 'Cerrar'
    installHeader.appendChild(installCloseButton)

    const installRow = document.createElement('div')
    installRow.className = 'modal-button-row'
    installDialog.appendChild(installRow)

    const installInput = document.createElement('input')
    installInput.placeholder = installConfig.placeholder
    installRow.appendChild(installInput)

    const installSubmitButton = document.createElement('button')
    installSubmitButton.textContent = installConfig.buttonLabel
    installRow.appendChild(installSubmitButton)

    const installHint = document.createElement('p')
    installHint.className = 'field-hint'
    installHint.textContent = installConfig.hint
    installDialog.appendChild(installHint)

    const installStatus = document.createElement('p')
    installDialog.appendChild(installStatus)

    const closeInstallModal = (): void => {
      installBackdrop.hidden = true
    }

    installButton.addEventListener('click', () => {
      installBackdrop.hidden = false
      installInput.focus()
    })
    installCloseButton.addEventListener('click', closeInstallModal)
    // Clicking the dimmed backdrop itself closes the modal; clicking
    // inside the dialog must not (same pattern as the room's own roster/
    // danger-zone modals).
    installBackdrop.addEventListener('click', (event) => {
      if (event.target === installBackdrop) closeInstallModal()
    })
    installDialog.addEventListener('click', (event) => event.stopPropagation())

    installSubmitButton.addEventListener('click', async () => {
      const source = installInput.value.trim()
      installStatus.className = ''
      installStatus.textContent = source === '' ? '' : 'Instalando…'
      if (source === '') {
        return
      }
      installInput.disabled = true
      installSubmitButton.disabled = true
      try {
        await installConfig.install(source)
        installInput.value = ''
        installStatus.className = 'success'
        installStatus.textContent = installConfig.installedMessage
        await refreshList()
      } catch (error) {
        installStatus.className = 'error'
        installStatus.textContent = (error as Error).message
      } finally {
        installInput.disabled = false
        installSubmitButton.disabled = false
      }
    })
  }

  // ── Create/edit modal ────────────────────────────────────────────────
  const formBackdrop = document.createElement('div')
  formBackdrop.className = 'modal-backdrop'
  formBackdrop.hidden = true
  app.appendChild(formBackdrop)

  // "wide" (not the default 440px-capped .modal-dialog) -- the
  // prompt/body textarea below reads much better with real room instead
  // of wrapping constantly.
  const formCard = document.createElement('div')
  formCard.className = 'modal-dialog wide'
  formBackdrop.appendChild(formCard)

  const formHeader = document.createElement('div')
  formHeader.className = 'modal-dialog-header'
  formCard.appendChild(formHeader)

  const formHeading = document.createElement('h3')
  formHeading.textContent = config.formHeading
  formHeader.appendChild(formHeading)

  const formCloseButton = document.createElement('button')
  formCloseButton.className = 'modal-close'
  formCloseButton.textContent = '×'
  formCloseButton.title = 'Cerrar'
  formHeader.appendChild(formCloseButton)

  const nameLabel = document.createElement('label')
  nameLabel.className = 'field-label'
  nameLabel.textContent = 'Nombre'
  formCard.appendChild(nameLabel)

  const nameInput = document.createElement('input')
  nameInput.placeholder = config.namePlaceholder
  formCard.appendChild(nameInput)

  const nameHint = document.createElement('p')
  nameHint.className = 'field-hint'
  nameHint.textContent = config.nameHint
  formCard.appendChild(nameHint)

  const descriptionLabel = document.createElement('label')
  descriptionLabel.className = 'field-label'
  descriptionLabel.textContent = 'Descripción'
  formCard.appendChild(descriptionLabel)

  const descriptionInput = document.createElement('input')
  descriptionInput.placeholder = 'Una línea explicando qué hace'
  formCard.appendChild(descriptionInput)

  const descriptionHint = document.createElement('p')
  descriptionHint.className = 'field-hint'
  descriptionHint.textContent = 'Se muestra en la lista de arriba, y es lo que Claude lee para decidir cuándo usarlo.'
  formCard.appendChild(descriptionHint)

  // Sentinel for the always-appended "Personalizado" option -- lets
  // someone type any alias or full model id the preset list doesn't
  // know about yet (Anthropic ships new model families over time, and
  // the `claude` CLI has no command that lists valid ones to build this
  // list from dynamically) without waiting on an app update.
  const CUSTOM_MODEL_VALUE = '__custom__'

  let modelSelect: HTMLSelectElement | null = null
  let modelCustomInput: HTMLInputElement | null = null
  if (config.modelOptions) {
    const modelLabel = document.createElement('label')
    modelLabel.className = 'field-label'
    modelLabel.textContent = 'Modelo'
    formCard.appendChild(modelLabel)

    modelSelect = document.createElement('select')
    for (const option of config.modelOptions) {
      const optionEl = document.createElement('option')
      optionEl.value = option.value
      optionEl.textContent = option.label
      modelSelect.appendChild(optionEl)
    }
    const customOptionEl = document.createElement('option')
    customOptionEl.value = CUSTOM_MODEL_VALUE
    customOptionEl.textContent = 'Personalizado…'
    modelSelect.appendChild(customOptionEl)
    formCard.appendChild(modelSelect)

    modelCustomInput = document.createElement('input')
    modelCustomInput.placeholder = 'ej. claude-sonnet-6, o cualquier alias nuevo'
    modelCustomInput.hidden = true
    formCard.appendChild(modelCustomInput)

    modelSelect.addEventListener('change', () => {
      if (modelCustomInput) {
        modelCustomInput.hidden = modelSelect!.value !== CUSTOM_MODEL_VALUE
      }
    })

    const modelHint = document.createElement('p')
    modelHint.className = 'field-hint'
    modelHint.textContent = 'Fija qué modelo usa este agente al ejecutarse. Por defecto hereda el de la sesión.'
    formCard.appendChild(modelHint)
  }

  const bodyLabel = document.createElement('label')
  bodyLabel.className = 'field-label'
  bodyLabel.textContent = config.bodyLabel
  formCard.appendChild(bodyLabel)

  // Wrapped so the "@" mention popup below can be positioned absolutely
  // right under the textarea, instead of anywhere else in the form.
  const bodyWrapper = document.createElement('div')
  bodyWrapper.className = 'form-mention-wrapper'
  formCard.appendChild(bodyWrapper)

  const bodyInput = document.createElement('textarea')
  bodyInput.className = 'prompt-textarea'
  bodyInput.placeholder = config.bodyPlaceholder
  bodyInput.rows = 18
  bodyWrapper.appendChild(bodyInput)

  if (config.enableMentions) {
    setupMentionPicker(bodyInput, bodyWrapper, () => config.list(), () => editingEntry?.name ?? null)
  }

  // Preloaded via this agent's own `skills:` frontmatter (see
  // setupSkillPicker's own comment) -- declared here, not inside the
  // `if (config.skillsField)` block below, so enterEditMode/exitEditMode
  // and the create/update handler can read and reset it unconditionally
  // (a plain, always-empty, unused array on the Skills screen itself,
  // which never sets skillsField).
  let selectedSkills: string[] = []
  let skillChipsList: HTMLDivElement | null = null

  function renderSkillChips(): void {
    if (!skillChipsList) return
    skillChipsList.innerHTML = ''
    for (const skillName of selectedSkills) {
      const chip = document.createElement('span')
      chip.className = 'skill-chip'
      chip.textContent = skillName

      const removeButton = document.createElement('button')
      removeButton.type = 'button'
      removeButton.className = 'skill-chip-remove'
      removeButton.textContent = '×'
      removeButton.title = `Quitar ${skillName}`
      // Removing is this chip's own "×", not a second "#" pick (see
      // setupSkillPicker's getExcludedNames -- an already-selected skill
      // doesn't show up in that popup again anyway). Also cleans up the
      // "#name" reference left in the prompt (see setupSkillPicker's own
      // comment on why it's there at all) -- otherwise the chip is gone
      // but the text still points at a skill this agent no longer
      // preloads, which is exactly the stale, out-of-sync state this
      // whole pair of listeners exists to avoid.
      removeButton.addEventListener('click', () => {
        selectedSkills = selectedSkills.filter((name) => name !== skillName)
        stripSkillMentionFromBody(skillName)
        renderSkillChips()
      })
      chip.appendChild(removeButton)
      skillChipsList.appendChild(chip)
    }
  }

  // The other direction of the same sync: setupSkillPicker's own comment
  // explains why picking a skill leaves a "#name" reference in the
  // prompt body rather than just updating the structured list silently --
  // but that means the body text and selectedSkills are two independent
  // copies of the same fact, and editing (or deleting) that reference
  // by hand, directly in the textarea, has no way to reach the other
  // one on its own. Confirmed directly (user report): deleting "#name"
  // from the prompt left it still listed under "Skills" and still
  // written to the saved agent's frontmatter -- this is what keeps them
  // in sync when the *text* changes; the chip's own "×" (above) is what
  // keeps them in sync the other way, when the *list* changes instead.
  function stripSkillMentionFromBody(name: string): void {
    // Matches exactly the "#name " shape setupSkillPicker's own
    // insertion produces (trigger + name + one trailing space) -- covers
    // the untouched, common case; a manual edit that mangled the
    // surrounding whitespace in some unusual way may need cleaning up by
    // hand, same as any other hand-edited text.
    bodyInput.value = bodyInput.value.replace(new RegExp(`#${name} `), '')
  }

  function syncSkillsFromBodyText(): void {
    const text = bodyInput.value
    const stillMentioned = selectedSkills.filter((name) => new RegExp(`(?:^|\\s)#${name}(?:\\s|$)`).test(text))
    if (stillMentioned.length !== selectedSkills.length) {
      selectedSkills = stillMentioned
      renderSkillChips()
    }
  }

  if (config.skillsField) {
    const skillsFieldConfig = config.skillsField

    const skillsLabel = document.createElement('label')
    skillsLabel.className = 'field-label'
    skillsLabel.textContent = 'Skills'
    formCard.appendChild(skillsLabel)

    const skillsHint = document.createElement('p')
    skillsHint.className = 'field-hint'
    skillsHint.textContent =
      'Escribe "#" dentro del prompt para elegir skills instaladas -- queda como referencia visible ahí, y además se precarga de verdad en este agente (campo skills: real).'
    formCard.appendChild(skillsHint)

    skillChipsList = document.createElement('div')
    skillChipsList.className = 'skill-chip-list'
    formCard.appendChild(skillChipsList)

    setupSkillPicker(
      bodyInput,
      bodyWrapper,
      () => skillsFieldConfig.listSkills(),
      () => selectedSkills,
      (skillName) => {
        selectedSkills = [...selectedSkills, skillName]
        renderSkillChips()
      }
    )

    // Runs on every keystroke, same as setupSkillPicker's own "#" popup
    // listener (both are plain `input` listeners on the same textarea,
    // and DOM allows any number of them) -- see syncSkillsFromBodyText's
    // own comment for why this direction of the sync needs a listener at
    // all, separate from picking or removing a skill.
    bodyInput.addEventListener('input', syncSkillsFromBodyText)
  }

  // Visible in both create and edit mode now (confirmed by direct user
  // request after noticing it was edit-only at first) -- but only edit
  // mode can attach right away, since a brand-new entry has no directory
  // to copy into until it's actually saved. Creating instead *stages* the
  // chosen file (pendingAttachFilePath) and the create handler below
  // attaches it right after the new entry's path is known.
  // `refreshAttachedFiles` needs `editingEntry` (set by enterEditMode
  // below, defined later in this same function) -- safe despite the
  // textual order since this is only ever called from an event handler,
  // well after the whole screen has finished its first, synchronous build.
  let attachedFilesList: HTMLDivElement | null = null
  let refreshAttachedFiles: () => Promise<void> = async () => {}
  let pendingAttachFilePath: string | null = null
  let pendingAttachLabel: HTMLParagraphElement | null = null

  if (config.attachFile) {
    const attachFileConfig = config.attachFile

    const attachedFilesSection = document.createElement('div')
    formCard.appendChild(attachedFilesSection)

    const attachedFilesLabel = document.createElement('label')
    attachedFilesLabel.className = 'field-label'
    attachedFilesLabel.textContent = 'Archivos adjuntos'
    attachedFilesSection.appendChild(attachedFilesLabel)

    const attachedFilesHint = document.createElement('p')
    attachedFilesHint.className = 'field-hint'
    attachedFilesHint.textContent =
      'Un script que esta skill pueda ejecutar -- se guarda en su carpeta scripts/, y se referencia desde el prompt de arriba por esa ruta relativa (por ejemplo "scripts/mi_script.py"). Si todavía estás creando la skill, se copia apenas la guardes.'
    attachedFilesSection.appendChild(attachedFilesHint)

    attachedFilesList = document.createElement('div')
    attachedFilesList.className = 'peek-list'
    attachedFilesSection.appendChild(attachedFilesList)

    pendingAttachLabel = document.createElement('p')
    pendingAttachLabel.hidden = true
    attachedFilesSection.appendChild(pendingAttachLabel)

    const attachFileStatus = document.createElement('p')
    attachedFilesSection.appendChild(attachFileStatus)

    const addFileButton = document.createElement('button')
    addFileButton.textContent = 'Agregar archivo'
    attachedFilesSection.appendChild(addFileButton)

    refreshAttachedFiles = async (): Promise<void> => {
      if (!attachedFilesList) return
      if (!editingEntry) {
        attachedFilesList.innerHTML = ''
        return
      }
      const files = await attachFileConfig.listFiles(editingEntry.path).catch(() => [])
      attachedFilesList.innerHTML = ''
      if (files.length === 0) {
        const empty = document.createElement('p')
        empty.textContent = 'Sin archivos adjuntos todavía.'
        attachedFilesList.appendChild(empty)
        return
      }
      for (const fileName of files) {
        const row = document.createElement('div')
        row.className = 'roster-row'
        const nameEl = document.createElement('span')
        nameEl.textContent = `scripts/${fileName}`
        row.appendChild(nameEl)
        const removeButton = document.createElement('button')
        removeButton.textContent = 'Quitar'
        removeButton.addEventListener('click', async () => {
          if (!editingEntry) return
          try {
            await attachFileConfig.remove(editingEntry.path, fileName)
            await refreshAttachedFiles()
          } catch (error) {
            attachFileStatus.className = 'error'
            attachFileStatus.textContent = (error as Error).message
          }
        })
        row.appendChild(removeButton)
        attachedFilesList.appendChild(row)
      }
    }

    addFileButton.addEventListener('click', async () => {
      attachFileStatus.className = ''
      attachFileStatus.textContent = ''
      const sourcePath = await attachFileConfig.chooseFile().catch(() => null)
      if (sourcePath === null) return
      if (editingEntry) {
        try {
          await attachFileConfig.attach(editingEntry.path, sourcePath)
          await refreshAttachedFiles()
        } catch (error) {
          attachFileStatus.className = 'error'
          attachFileStatus.textContent = (error as Error).message
        }
      } else {
        // Not saved yet -- stage it, the create handler below attaches it
        // right after this entry's real path exists.
        pendingAttachFilePath = sourcePath
        if (pendingAttachLabel) {
          pendingAttachLabel.hidden = false
          pendingAttachLabel.textContent = `Se adjuntará al guardar: ${sourcePath.split('/').pop()}`
        }
      }
    })
  }

  const buttonRow = document.createElement('div')
  buttonRow.className = 'modal-button-row'
  formCard.appendChild(buttonRow)

  const createButton = document.createElement('button')
  createButton.textContent = 'Crear'
  buttonRow.appendChild(createButton)

  const cancelEditButton = document.createElement('button')
  cancelEditButton.textContent = 'Cancelar edición'
  cancelEditButton.hidden = true
  buttonRow.appendChild(cancelEditButton)

  const formStatus = document.createElement('p')
  formCard.appendChild(formStatus)

  // Set once "Editar" is clicked on an existing entry -- switches the
  // form from creating a new one to overwriting this one's description/
  // body in place. Renaming isn't supported here (every room's roster
  // references an agent by its file path), so the name field just goes
  // read-only instead of being hidden -- you still see what you're
  // editing.
  let editingEntry: CatalogEntry | null = null

  function enterEditMode(entry: CatalogEntry, body: string): void {
    editingEntry = entry
    nameInput.value = entry.name
    nameInput.disabled = true
    descriptionInput.value = entry.description
    bodyInput.value = body
    if (modelSelect) {
      const currentModel = entry.model ?? ''
      const isPreset = config.modelOptions?.some((preset) => preset.value === currentModel)
      if (currentModel !== '' && !isPreset) {
        // Not one of the presets (e.g. a full model id set by hand, or a
        // newer alias this app doesn't know about yet) -- route it
        // through "Personalizado" instead of silently discarding it the
        // moment this form gets saved.
        modelSelect.value = CUSTOM_MODEL_VALUE
        if (modelCustomInput) {
          modelCustomInput.value = currentModel
          modelCustomInput.hidden = false
        }
      } else {
        modelSelect.value = currentModel
        if (modelCustomInput) {
          modelCustomInput.value = ''
          modelCustomInput.hidden = true
        }
      }
    }
    selectedSkills = entry.skills ? [...entry.skills] : []
    renderSkillChips()
    void refreshAttachedFiles()
    createButton.textContent = 'Actualizar'
    cancelEditButton.hidden = false
    formStatus.className = ''
    formStatus.textContent = ''
    formBackdrop.hidden = false
  }

  function exitEditMode(): void {
    editingEntry = null
    nameInput.value = ''
    nameInput.disabled = false
    descriptionInput.value = ''
    bodyInput.value = ''
    if (modelSelect) {
      modelSelect.value = ''
      if (modelCustomInput) {
        modelCustomInput.value = ''
        modelCustomInput.hidden = true
      }
    }
    selectedSkills = []
    renderSkillChips()
    pendingAttachFilePath = null
    if (pendingAttachLabel) {
      pendingAttachLabel.hidden = true
    }
    void refreshAttachedFiles()
    createButton.textContent = 'Crear'
    cancelEditButton.hidden = true
  }

  const closeFormModal = (): void => {
    exitEditMode()
    formStatus.className = ''
    formStatus.textContent = ''
    formBackdrop.hidden = true
  }

  newButton.addEventListener('click', () => {
    // Starting a fresh "create new" from a state left over by a previous
    // edit (cancelled mid-way, or never explicitly closed) -- reset
    // first, so the modal never opens pre-filled with someone else's
    // entry.
    exitEditMode()
    formStatus.className = ''
    formStatus.textContent = ''
    formBackdrop.hidden = false
    nameInput.focus()
  })
  formCloseButton.addEventListener('click', closeFormModal)
  // Clicking the dimmed backdrop itself closes the modal; clicking
  // inside the dialog must not (same pattern as the room's own roster/
  // danger-zone modals, and this screen's own install modal above).
  formBackdrop.addEventListener('click', (event) => {
    if (event.target === formBackdrop) closeFormModal()
  })
  formCard.addEventListener('click', (event) => event.stopPropagation())

  cancelEditButton.addEventListener('click', closeFormModal)

  async function refreshList(): Promise<void> {
    list.innerHTML = ''
    try {
      const entries = await config.list()
      if (entries.length === 0) {
        const empty = document.createElement('p')
        empty.textContent = config.emptyMessage
        list.appendChild(empty)
        return
      }
      for (const entry of entries) {
        const row = document.createElement('div')
        row.className = 'roster-row'

        const info = document.createElement('div')
        const name = document.createElement('strong')
        name.textContent = entry.name
        info.appendChild(name)
        const desc = document.createElement('p')
        desc.className = 'cwd'
        desc.textContent = entry.description
        info.appendChild(desc)
        row.appendChild(info)

        const actions = document.createElement('div')
        actions.className = 'catalog-row-actions'

        const editButton = document.createElement('button')
        editButton.className = 'edit-name-link'
        editButton.textContent = 'Editar'
        editButton.addEventListener('click', async () => {
          editButton.disabled = true
          try {
            const body = await config.getBody(entry.path)
            enterEditMode(entry, body)
          } catch (error) {
            window.alert((error as Error).message)
          } finally {
            editButton.disabled = false
          }
        })
        actions.appendChild(editButton)

        const deleteButton = document.createElement('button')
        deleteButton.className = 'delete-link'
        deleteButton.textContent = 'Eliminar'
        deleteButton.addEventListener('click', async () => {
          const confirmed = window.confirm(config.deleteConfirm(entry.name))
          if (!confirmed) {
            return
          }
          deleteButton.disabled = true
          try {
            await config.remove(entry.path)
            if (editingEntry?.path === entry.path) {
              // The modal (if open) was showing this exact entry --
              // leaving it open would show now-stale content.
              closeFormModal()
            }
            await refreshList()
          } catch (error) {
            window.alert((error as Error).message)
            deleteButton.disabled = false
          }
        })
        actions.appendChild(deleteButton)

        row.appendChild(actions)
        list.appendChild(row)
      }
    } catch (error) {
      const errorEl = document.createElement('p')
      errorEl.className = 'error'
      errorEl.textContent = (error as Error).message
      list.appendChild(errorEl)
    }
  }

  createButton.addEventListener('click', async () => {
    formStatus.className = ''
    formStatus.textContent = ''
    const description = descriptionInput.value.trim()
    const body = bodyInput.value.trim()
    const model = modelSelect
      ? modelSelect.value === CUSTOM_MODEL_VALUE
        ? modelCustomInput!.value.trim()
        : modelSelect.value
      : undefined
    try {
      if (editingEntry) {
        await config.update(editingEntry.name, description, body, model, selectedSkills)
        formStatus.className = 'success'
        formStatus.textContent = config.updatedMessage
        // Closes the modal instead of exitEditMode()'s old plain reset --
        // that used to leave the just-saved update looking exactly like
        // "Crear nuevo agente" again (same blank form, same button
        // label), which read as if the edit had been discarded rather
        // than saved. A brief flash of the success message first, then
        // close, rather than closing instantly out from under it.
        setTimeout(closeFormModal, 500)
      } else {
        const createdName = nameInput.value.trim()
        await config.create(createdName, description, body, model, selectedSkills)
        formStatus.className = 'success'
        formStatus.textContent = config.createdMessage
        // The file staged in create mode (see addFileButton's own
        // comment) only gets attached here, now that the entry actually
        // has a real path -- config.create itself never returns one, so
        // this re-lists and finds it by the name just used, same lookup
        // "Editar" already does for an existing entry.
        if (config.attachFile && pendingAttachFilePath) {
          const filePathToAttach = pendingAttachFilePath
          try {
            const created = (await config.list()).find((entry) => entry.name === createdName)
            if (created) {
              await config.attachFile.attach(created.path, filePathToAttach)
              formStatus.textContent = `${config.createdMessage} Archivo adjuntado.`
            } else {
              formStatus.textContent = `${config.createdMessage} (No se pudo adjuntar el archivo: no se encontró la entrada recién creada.)`
            }
          } catch (error) {
            formStatus.textContent = `${config.createdMessage} (No se pudo adjuntar el archivo: ${(error as Error).message})`
          }
          pendingAttachFilePath = null
          if (pendingAttachLabel) {
            pendingAttachLabel.hidden = true
          }
        }
        nameInput.value = ''
        descriptionInput.value = ''
        bodyInput.value = ''
        if (modelSelect) {
          modelSelect.value = ''
        }
        if (modelCustomInput) {
          modelCustomInput.value = ''
          modelCustomInput.hidden = true
        }
        selectedSkills = []
        renderSkillChips()
      }
      await refreshList()
    } catch (error) {
      formStatus.className = 'error'
      formStatus.textContent = (error as Error).message
    }
  })

  await refreshList()
}

export async function openAgentsScreen(): Promise<void> {
  return openCatalogScreen({
    title: 'Agentes',
    storageNote:
      'Se guardan en ~/.claude/agents/ — quedan disponibles para cualquier sesión de Claude Code en esta máquina, no solo para clauditto.',
    emptyMessage: 'Todavía no tienes agentes de usuario.',
    formHeading: 'Crear nuevo agente',
    namePlaceholder: 'ej. code-reviewer',
    nameHint: 'Minúsculas, números y guiones — debe empezar con una letra.',
    bodyLabel: 'Prompt (instrucciones para el agente)',
    bodyPlaceholder: 'Eres un agente especializado en… Escribe @ para referenciar otro agente.',
    createdMessage: 'Agente creado.',
    updatedMessage: 'Agente actualizado.',
    deleteConfirm: (name) => `¿Eliminar el agente "${name}"? Esta acción no se puede deshacer.`,
    list: () => api.listUserAgents(),
    create: (name, description, body, model, skills) =>
      api.createUserAgent(name, description, body, model, skills),
    remove: (path) => api.deleteUserAgent(path),
    getBody: (path) => api.getUserAgentBody(path),
    update: (name, description, body, model, skills) =>
      api.updateUserAgent(name, description, body, model, skills),
    modelOptions: [
      { value: '', label: 'Heredado (usa el modelo de la sesión)' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
      { value: 'haiku', label: 'Haiku' },
      { value: 'fable', label: 'Fable' }
    ],
    enableMentions: true,
    skillsField: {
      listSkills: () => api.listUserSkills()
    }
  })
}

export async function openSkillsScreen(): Promise<void> {
  return openCatalogScreen({
    title: 'Skills',
    storageNote:
      'Se guardan en ~/.claude/skills/ — quedan disponibles para cualquier sesión de Claude Code en esta máquina, no solo para clauditto.',
    emptyMessage: 'Todavía no tienes skills de usuario.',
    formHeading: 'Crear nueva skill',
    namePlaceholder: 'ej. cdp-verify',
    nameHint: 'Minúsculas, números y guiones — debe empezar con una letra.',
    bodyLabel: 'Contenido (instrucciones de la skill)',
    bodyPlaceholder: 'Pasos a seguir cuando se use esta skill…',
    createdMessage: 'Skill creada.',
    updatedMessage: 'Skill actualizada.',
    deleteConfirm: (name) => `¿Eliminar la skill "${name}"? Esta acción no se puede deshacer.`,
    list: () => api.listUserSkills(),
    create: (name, description, body) => api.createUserSkill(name, description, body),
    remove: (path) => api.deleteUserSkill(path),
    getBody: (path) => api.getUserSkillBody(path),
    update: (name, description, body) => api.updateUserSkill(name, description, body),
    installFromSource: {
      heading: 'Instalar desde GitHub',
      placeholder: 'usuario/repositorio -- ej. javierlecca/btc-paper-trade-skill',
      hint:
        'Solo el "usuario/repositorio" (no el comando completo, ni "npx skills add"): la app arma el comando por ti. Usa "npx skills" (herramienta de terceros, de Vercel Labs -- no es de Anthropic) para instalarla globalmente en ~/.claude/skills/, igual que las creadas a mano. Requiere Node.js instalado. Si ya existe una skill con el mismo nombre, puede sobrescribirla sin avisar -- fíjate en la lista de abajo antes de instalar.',
      buttonLabel: 'Instalar',
      installedMessage: 'Skill instalada.',
      install: (source) => api.installSkillFromGithub(source)
    },
    attachFile: {
      listFiles: (path) => api.listSkillFiles(path),
      chooseFile: () => api.chooseFile(),
      attach: (path, sourceFilePath) => api.attachSkillFile(path, sourceFilePath),
      remove: (path, fileName) => api.removeSkillFile(path, fileName)
    }
  })
}
