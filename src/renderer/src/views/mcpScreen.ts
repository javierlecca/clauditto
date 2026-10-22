// MCP servers manager -- same shape as the Agentes/Skills screens
// (catalogScreen.ts): a list of what's configured, plus a modal form to
// add a new one. Kept as its own small screen instead of squeezed into
// openCatalogScreen's shared config, since an MCP server has a
// completely different shape (transport/command/URL, no prompt body, no
// @-mentions) -- reusing that config here would mean more unused fields
// than used ones.
//
// Always registers at --scope user (see mcp.ts's own comment on
// addMcpServer) -- this screen has no per-project notion at all, same as
// Agentes/Skills, which also live at the user level (~/.claude/).
import { api } from '../api'
import { renderSessionList } from './dashboard'

const app = document.getElementById('app')
if (!app) {
  throw new Error('Missing #app element')
}

export async function openMcpScreen(): Promise<void> {
  app.innerHTML = ''

  const backButton = document.createElement('button')
  backButton.textContent = '← Back'
  backButton.addEventListener('click', renderSessionList)
  app.appendChild(backButton)

  const heading = document.createElement('h2')
  heading.textContent = 'MCPs'
  app.appendChild(heading)

  const storageNote = document.createElement('p')
  storageNote.className = 'cwd'
  storageNote.textContent =
    'Servidores MCP disponibles para cualquier sala en esta máquina (--scope user) -- lo mismo que ves con "claude mcp list" en una terminal.'
  app.appendChild(storageNote)

  const toolbar = document.createElement('div')
  toolbar.className = 'room-toolbar'
  app.appendChild(toolbar)

  const newButton = document.createElement('button')
  newButton.textContent = 'Agregar servidor MCP'
  toolbar.appendChild(newButton)

  const list = document.createElement('div')
  list.className = 'roster-list'
  app.appendChild(list)

  // ── "Agregar servidor MCP" modal ────────────────────────────────────
  const formBackdrop = document.createElement('div')
  formBackdrop.className = 'modal-backdrop'
  formBackdrop.hidden = true
  app.appendChild(formBackdrop)

  const formCard = document.createElement('div')
  formCard.className = 'modal-dialog'
  formBackdrop.appendChild(formCard)

  const formHeader = document.createElement('div')
  formHeader.className = 'modal-dialog-header'
  formCard.appendChild(formHeader)

  const formHeading = document.createElement('h3')
  formHeading.textContent = 'Agregar servidor MCP'
  formHeader.appendChild(formHeading)

  const formCloseButton = document.createElement('button')
  formCloseButton.className = 'modal-close'
  formCloseButton.textContent = '×'
  formCloseButton.title = 'Cerrar'
  formHeader.appendChild(formCloseButton)

  // One field: pega el comando completo tal cual lo usarías en una
  // terminal -- un formulario con nombre/transporte/comando separados
  // (una versión anterior de esto) resultaba más confuso que el propio
  // comando, y obligar a cortar el "claude mcp add" antes de pegarlo solo
  // suma otro paso para marearse. addMcpServer (mcp.ts) acepta el comando
  // completo o solo la parte después de "add" -- ambos funcionan igual.
  const commandInput = document.createElement('input')
  commandInput.placeholder = 'claude mcp add --transport http miro https://mcp.miro.com'
  formCard.appendChild(commandInput)

  const formHint = document.createElement('p')
  formHint.className = 'field-hint'
  formHint.textContent =
    'Pegá el comando completo, tal cual lo escribirías en una terminal -- ej. "claude mcp add --transport http miro https://mcp.miro.com", o "claude mcp add context7 -- npx -y @upstash/context7-mcp" para un servidor local. Siempre se agrega como global (--scope user) para cualquier sala, sin importar qué scope pongas en el comando.'
  formCard.appendChild(formHint)

  const createButton = document.createElement('button')
  createButton.textContent = 'Agregar'
  formCard.appendChild(createButton)

  const formStatus = document.createElement('p')
  formCard.appendChild(formStatus)

  function closeFormModal(): void {
    formBackdrop.hidden = true
    commandInput.value = ''
    formStatus.className = ''
    formStatus.textContent = ''
  }

  newButton.addEventListener('click', () => {
    formBackdrop.hidden = false
    commandInput.focus()
  })
  formCloseButton.addEventListener('click', closeFormModal)
  // Clicking the dimmed backdrop itself closes the modal; clicking
  // inside the dialog must not (same pattern as every other modal in
  // this app -- see e.g. roomDetail.ts's own danger-zone modal).
  formBackdrop.addEventListener('click', (event) => {
    if (event.target === formBackdrop) closeFormModal()
  })
  formCard.addEventListener('click', (event) => event.stopPropagation())

  async function refreshList(): Promise<void> {
    list.innerHTML = ''
    try {
      const entries = await api.listMcpServers()
      if (entries.length === 0) {
        const empty = document.createElement('p')
        empty.textContent = 'Todavía no tienes servidores MCP configurados.'
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
        const target = document.createElement('p')
        target.className = 'cwd'
        target.textContent = entry.target
        info.appendChild(target)
        const status = document.createElement('p')
        status.className = 'cwd'
        status.textContent = entry.status
        info.appendChild(status)
        row.appendChild(info)

        const actions = document.createElement('div')
        actions.className = 'catalog-row-actions'

        const removeButton = document.createElement('button')
        removeButton.className = 'delete-link'
        removeButton.textContent = 'Quitar'
        removeButton.addEventListener('click', async () => {
          const confirmed = window.confirm(`¿Quitar el servidor MCP "${entry.name}"?`)
          if (!confirmed) {
            return
          }
          removeButton.disabled = true
          try {
            await api.removeMcpServer(entry.name)
            await refreshList()
          } catch (error) {
            window.alert((error as Error).message)
            removeButton.disabled = false
          }
        })
        actions.appendChild(removeButton)

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
    try {
      await api.addMcpServer(commandInput.value)
      formStatus.className = 'success'
      formStatus.textContent = 'Servidor MCP agregado.'
      await refreshList()
      setTimeout(closeFormModal, 500)
    } catch (error) {
      formStatus.className = 'error'
      formStatus.textContent = (error as Error).message
    }
  })

  await refreshList()
}
