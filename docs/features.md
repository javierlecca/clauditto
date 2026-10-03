# Clauditto features

Reference for everything the app can do today. Clauditto is a desktop
dashboard for running several Claude Code sessions ("rooms") at once:
creating them, watching them work, sending them tasks, and coordinating
them with each other.

> **Note on UI text:** the app's own interface is in Spanish. Button and
> menu labels below are quoted exactly as they appear on screen, with an
> English gloss in parentheses the first time each one shows up.

## 1. Dashboard

The main screen when you open the app (after a ~6-second animated splash
screen).

- **Room list**: one card per session, with a small animated "office"
  (employees typing, someone getting coffee, etc.) whose color/state
  reflects whether the room is working, blocked, stopped, or off.
- **Search box**: filters cards by name or folder in real time, no reload.
- **Total usage**: estimated cost and tokens across all rooms (not
  Anthropic's real billing, just an estimate).
- **Nav bar**: "Agentes" (Agents), "Skills", "Nueva sala" (New room),
  "Enviar a varias salas" / "Tareas distintas por sala" (Send to several
  rooms / Different tasks per room — only when there are eligible rooms),
  "Refresh".
- **History**: closed interactive sessions ("Apagadas"/Off) show up mixed
  into the same grid, as a grayed-out card — there's no separate "History"
  screen.

## 2. Creating a new room

"Nueva sala" (New room) button → modal:

- Optional name + folder picker (via the OS's native dialog).
- If the folder was never used with Claude Code before, the **embedded
  trust flow** kicks in: instead of sending you to a separate terminal,
  the app starts a hidden `claude` process in that folder and shows two
  buttons ("Sí, confío" / "No" — Yes, I trust it / No) that answer the
  trust prompt for you, automatically retrying room creation once you
  accept.

## 3. Room card (dashboard)

Each card has, depending on the room's type:

- **"Editar"** (Edit/rename) — unavailable for interactive sessions opened
  by hand, or for a "failed" room with no live process.
- **Delete** (trash icon) — deletes the session and its history, with
  confirmation.
- **"Prender →"** (Power on →) — wakes up a stopped room.
- **"Enter →"** / **"Ver →"** (View →) — opens the room (read-only if it's
  an interactive session this app doesn't control).
- **Agent count** and **estimated usage** (cost + tokens) for that room.
- **Colored dot** on the title if the room changed state while you weren't
  looking (clears once you open it).
- **"🔔 Ver qué pregunta"** (See what it's asking): if the room is blocked
  waiting on something, opens a modal that reads straight from its
  transcript what it's waiting for — and if it's a simple permission, you
  can **approve or deny it right there** without entering the room.

## 4. Inside a room

Once you're in (via "Enter →"/"Ver →" or a notification/toast):

- **"Volver →"** (Back →): if this room received a task from another room
  (via dispatch), a link to jump back to the room that sent it.
- **"Gestionar agentes"** (Manage agents): modal with the roster of agents
  assigned to this specific room (add from the catalog, remove, and a
  heads-up if Claude used an agent that isn't on the roster yet).
- **"Gestionar sala"** (Manage room): modal with the destructive actions —
  **"Apagar sala"** (Power off room — pauses it, keeps the history, you
  can power it back on) and **"Eliminar sala"** (Delete room — erases
  everything, can't be undone).
- **"Entrar al terminal"** (Enter the terminal): mounts the embedded
  terminal (see section 5).
- Read-only interactive sessions instead show their **recent activity**
  (a summary of the transcript, with no way to write to them).

## 5. Embedded terminal

A real terminal (xterm.js) connected to the actual `claude` session — you
can type, paste, scroll, everything like a real terminal, plus:

- **`@name`**: a popup to reference an agent from this room's roster by
  name (instead of Claude Code's own native autocomplete, which lists
  *every* agent on the machine).
- **`$name`**: a popup to reference another Clauditto room. Picking one
  inserts `$"RoomName (session)"` as plain text — you keep typing your
  message right there, and it's this room's own Claude that recognizes
  the reference and asks that other room for something (see section 6).
  If you type `$` followed by something that doesn't match any room
  (e.g. a price, "$50"), it's sent as plain text with no effect.
- **Pasting images** (Cmd+V or Ctrl+V): detects an image on the clipboard,
  saves it to a temp file, and types the path for Claude Code — sidesteps
  the CLI's own known bug with image pasting.
- **Copy** (Cmd+C with an active selection): copies the selection to the
  system clipboard.
- **Shift+Enter**: inserts a newline instead of sending.
- **Scroll buttons** (▲/▼): for when the mouse wheel doesn't reach (Claude
  Code manages its own screen buffer).

## 6. Dispatch between rooms ("ask another room for something")

Three ways to coordinate rooms with each other:

- **`$name` in the terminal** (section 5): the most common one — you ask
  another room for something without leaving your current conversation,
  with all the context you already had.
- **"Enviar a varias salas"** (Send to several rooms, dashboard): the same
  message to several checkbox-picked rooms at once.
- **"Tareas distintas por sala"** (Different tasks per room, dashboard): a
  different message per room (one textarea per room, empty = that room is
  skipped).

When the asked room finishes (or fails, or stops), **the result is
forwarded on its own** to the room that asked, as a new message — no need
to go fetch it by hand.

## 7. Notifications and alerts

- **In-app toasts**: show up when a room changes state (started working,
  got blocked, finished, failed, stopped). Clickable — they take you
  straight to that room. Auto-dismiss after 5 seconds.
- **Native OS notifications**: the same heads-up, for when you're not
  looking at the Clauditto window.
- The polling that detects these changes runs the whole time the app is
  open, not just while you're looking at the dashboard.

## 8. History (powered-off rooms)

Closed interactive sessions show up as grayed-out cards in the same
dashboard. **"Prender →"** resumes them in the background (without opening
a terminal yet) and, as soon as it confirms the session is really alive,
swaps the card for its "Reanudada" (Resumed) version — without reloading
the whole screen.

## 9. Agent catalog

"Agentes" (Agents) screen (nav bar):

- Create/edit/delete user agents (`~/.claude/agents/`, available to any
  Claude Code session on the machine, not just Clauditto).
- Optional fixed **model** field (Sonnet/Opus/Haiku/Fable/inherited, or a
  custom alias).
- **`@` inside the prompt**: reference another agent by name as you type.
- **`#` inside the prompt**: preloads an installed skill into the agent's
  real `skills:` field (not just text — it becomes a visible reference
  *and* structured data).

## 10. Skill catalog

"Skills" screen (nav bar): same layout as agents, plus:

- **Install from GitHub** (`user/repo`, via the third-party `npx skills`
  tool).
- **Attached files**: upload a script into the skill's `scripts/` folder,
  referenceable from the prompt by its relative path.

## 11. Usage and cost

A "~$X.XX · N tokens" badge (an estimate, not Anthropic's real billing) on
every room/history card, plus a running total on the dashboard.

## 12. Login and folder trust

- If `claude` has no active session, instead of an error message the app
  shows an **embedded login terminal** — you log in right there and the
  app moves on to the dashboard on its own as soon as it detects you're
  in.
- If a folder was never confirmed as trusted for Claude Code, the same
  kind of hidden terminal answers the trust prompt for you (see section 2).
