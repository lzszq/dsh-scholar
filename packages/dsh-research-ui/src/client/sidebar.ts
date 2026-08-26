import type { ContextMenuItem, ProjectRow } from './types'
import { api } from './api'
import { openDeleteProjectModal, openNewProjectModal, openProjectDetailModal, openRenameModal } from './modals/project'
import { openCompareModal } from './modals/search'
import { openSettingsModal } from './modals/settings'
import { chatDiscardProject, favProjectToggle, favProjects, state, tabSave } from './state'
import { STATUS_META, copyText, el, openContextMenu, rootHost, showToast, statusLabel } from './ui'
import { t } from './i18n/index'
/** Sidebar search filter (dsh-web "Search sessions" feel). */
export let sidebarQuery = ''
/** Sidebar grouping (dsh-web "Group by" feel): all | active | done. */
export let sidebarGroup: 'all' | 'active' | 'done' | 'archived' = 'all'
/** Sidebar sort order (dsh-web sort toggle), persisted. */
export let sidebarSort: 'recent' | 'name' = 'recent'
export const SIDEBAR_SORT_KEY = 'dsh-scholar-ui-sidebar-sort'
export function sidebarSortLoad(): void {
  try {
    const v = localStorage.getItem(SIDEBAR_SORT_KEY)
    if (v === 'name' || v === 'recent') sidebarSort = v
  } catch { /* private mode */ }
}
export function sidebarSortPersist(): void {
  try { localStorage.setItem(SIDEBAR_SORT_KEY, sidebarSort) } catch { /* private mode */ }
}

/** Projects considered "active" (still in the research pipeline). */
export function isProjectActive(status: string | undefined): boolean {
  return status !== 'RELEASED' && status !== 'ARCHIVED'
}

/**
 * dsh-web-style workspace sidebar: search box + group filter, one row per
 * project (name + status dot/label), the active one highlighted; the
 * workspace header owns project creation.
 */

export function renderSidebar(
  sidebar: HTMLElement,
  projects: ProjectRow[],
  activeId: string | undefined,
  onPick: (projectId: string) => void,
  sidebarToggle?: HTMLElement,
): void {
  sidebar.replaceChildren()

  const brandRow = el('div', 'sidebar-brand-row')
  brandRow.append(el('span', 'sidebar-wordmark', t('shell', 'shell.sidebar.wordmark')), el('span', 'sidebar-product', t('shell', 'shell.sidebar.product')))
  if (sidebarToggle !== undefined) brandRow.appendChild(sidebarToggle)
  sidebar.appendChild(brandRow)

  const head = el('div', 'sidebar-head')
  head.appendChild(el('span', 'sidebar-title', t('shell', 'shell.sidebar.title')))
  // dsh-web sort toggle: recent activity vs alphabetical.
  const sortBtn = el('button', 'sidebar-new', sidebarSort === 'name' ? 'A–Z' : t('shell', 'shell.sidebar.sortRecent'))
  sortBtn.title = sidebarSort === 'name' ? t('shell', 'shell.sidebar.sortByName') : t('shell', 'shell.sidebar.sortByRecent')
  sortBtn.style.cssText = 'padding:1px 8px;font-size:10px'
  sortBtn.onclick = () => {
    sidebarSort = sidebarSort === 'recent' ? 'name' : 'recent'
    sidebarSortPersist()
    renderSidebar(sidebar, projects, activeId, onPick, sidebarToggle)
  }
  head.appendChild(sortBtn)
  const newBtn = el('button', 'sidebar-new', '＋')
  newBtn.title = t('shell', 'shell.sidebar.newTitle')
  newBtn.setAttribute('aria-label', t('shell', 'shell.sidebar.newAria'))
  newBtn.onclick = () => {
    const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
    if (root != null) openNewProjectModal(root)
  }
  head.appendChild(newBtn)
  sidebar.appendChild(head)

  // Search box: filters the project rows in place (keeps input focus,
  // dsh-web "Search sessions" feel).
  const search = document.createElement('input')
  search.className = 'sidebar-search'
  search.type = 'text'
  search.placeholder = t('shell', 'shell.sidebar.searchPlaceholder')
  search.value = sidebarQuery
  // dsh-web search box: Escape clears the filter in place.
  search.onkeydown = (event) => {
    if (event.key === 'Escape' && search.value !== '') {
      event.stopPropagation()
      search.value = ''
      sidebarQuery = ''
      renderRows()
    }
  }
  sidebar.appendChild(search)

  // Group by (dsh-web "Group by"): all / active / done.
  const groupRow = el('div', 'sidebar-groups')
  const GROUP_DEFS: Array<['all' | 'active' | 'done' | 'archived', string]> = [
    ['all', t('shell', 'shell.sidebar.groupAll')], ['active', t('shell', 'shell.sidebar.groupActive')],
    ['done', t('shell', 'shell.sidebar.groupDone')], ['archived', t('shell', 'shell.sidebar.groupArchived')],
  ]
  for (const [key, label] of GROUP_DEFS) {
    const chip = el('button', 'sidebar-filter')
    chip.textContent = label
    chip.classList.toggle('active', sidebarGroup === key)
    chip.onclick = () => { sidebarGroup = key; renderSidebar(sidebar, projects, activeId, onPick, sidebarToggle) }
    groupRow.appendChild(chip)
  }
  sidebar.appendChild(groupRow)

  const list = el('div', 'sidebar-list')
  list.setAttribute('role', 'tree')
  list.setAttribute('aria-label', t('shell', 'shell.sidebar.workspacesAria'))
  // dsh-web counts: the footer shows the filtered/total project counts.
  const footLabel = el('span', '', t('shell', 'shell.sidebar.projectCount', { count: String(projects.length) }))
  const renderRows = (): void => {
    list.replaceChildren()
    const q = sidebarQuery.trim().toLowerCase()
    const base = sidebarSort === 'name'
      ? [...projects].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      : projects
    let filtered = q === '' ? base : base.filter(p => (p.name ?? '').toLowerCase().includes(q) || (p.project_id ?? '').toLowerCase().includes(q) || (p.status ?? '').toLowerCase().includes(q))
    if (sidebarGroup === 'active') filtered = filtered.filter(p => isProjectActive(p.status))
    if (sidebarGroup === 'done') filtered = filtered.filter(p => !isProjectActive(p.status))
    if (sidebarGroup === 'archived') filtered = filtered.filter(p => p.status === 'ARCHIVED')
    // dsh-web starred projects: favourites sort to the top.
    if (favProjects.size > 0) {
      filtered = [...filtered].sort((a, b) => (favProjects.has(b.project_id ?? '') ? 1 : 0) - (favProjects.has(a.project_id ?? '') ? 1 : 0))
    }
    // dsh-web counts: reflect the active filter in the footer.
    footLabel.textContent = q === '' && sidebarGroup === 'all'
      ? t('shell', 'shell.sidebar.projectCount', { count: String(projects.length) })
      : t('shell', 'shell.sidebar.projectCount', { count: `${filtered.length}/${projects.length}` })
    if (filtered.length === 0) {
      const empty = el('div', 'empty', projects.length === 0
        ? t('shell', 'shell.sidebar.emptyNoProjects')
        : t('shell', 'shell.sidebar.emptyNoMatch'))
      empty.style.cssText = 'padding:10px 12px'
      list.appendChild(empty)
      return
    }
    for (const p of filtered) {
      const item = el('button', 'ws-item')
      item.setAttribute('role', 'treeitem')
      item.setAttribute('aria-label', t('shell', 'shell.sidebar.itemAria', { name: p.name ?? p.project_id ?? '' }))
      // dsh-web starred projects: ★ toggles the favourite (sorted first).
      const isFav = p.project_id !== undefined && favProjects.has(p.project_id)
      const favStar = el('span', '', isFav ? '★' : '☆')
      favStar.style.cssText = `cursor:pointer;color:${isFav ? 'var(--tone-amber)' : 'var(--text-3)'};font-size:10px;flex-shrink:0`
      favStar.title = isFav ? t('shell', 'shell.sidebar.unfavTitle') : t('shell', 'shell.sidebar.favTitle')
      favStar.onclick = (event) => {
        event.stopPropagation()
        if (p.project_id === undefined) return
        favProjectToggle(p.project_id)
        renderSidebar(sidebar, projects, activeId, onPick, sidebarToggle)
      }
      item.appendChild(favStar)
      if (p.project_id === activeId) {
        item.classList.add('active')
        item.setAttribute('aria-current', 'page')
      }
      if (sidebarSelecting && p.project_id !== undefined) {
        if (sidebarSelected.has(p.project_id)) item.classList.add('selected')
        const box = el('span', 'ws-check', sidebarSelected.has(p.project_id) ? '☑' : '☐')
        box.title = t('shell', 'shell.sidebar.toggleSelection')
        box.onclick = (event) => {
          event.stopPropagation()
          if (p.project_id === undefined) return
          if (sidebarSelected.has(p.project_id)) sidebarSelected.delete(p.project_id)
          else sidebarSelected.add(p.project_id)
          renderSidebar(sidebar, projects, activeId, onPick, sidebarToggle)
        }
        item.prepend(box)
      }
      // dsh-web "attention" feel: BLOCKED_GATE projects get a red ring and
      // an ⏳ badge so a parked project is visible in the sidebar.
      const blocked = p.status === 'BLOCKED_GATE'
      if (blocked) item.classList.add('blocked')
      const tone = STATUS_META[p.status ?? '']?.tone ?? 'slate'
      const dot = el('span', 'ws-dot')
      dot.style.background = `var(--tone-${tone})`
      item.appendChild(dot)
      const itemText = el('span', 'ws-text')
      itemText.append(
        el('span', 'ws-name', p.name ?? p.project_id ?? ''),
        el('span', 'ws-status', statusLabel(p.status)),
      )
      item.appendChild(itemText)
      if (blocked) {
        const badge = el('span', 'ws-status', '!')
        badge.title = t('shell', 'shell.sidebar.blockedTitle')
        badge.style.cssText = 'color:var(--tone-amber);font-weight:700;cursor:pointer'
        badge.onclick = (event) => {
          event.stopPropagation()
          if (p.project_id !== undefined) onPick(p.project_id)
          state.activeTab = 'gates'
          tabSave()
          state.rerender()
        }
        item.appendChild(badge)
      }
      item.onclick = () => { if (p.project_id !== undefined) onPick(p.project_id) }
      // dsh-web tooltip: full identity of the project on hover. Raw wire
      // join (name · status · id) — no UI prose, kept verbatim (§8 line 115).
      item.title = `${p.name ?? ''} · ${p.status ?? ''} · ${p.project_id ?? ''}`
      // dsh-web context menu: right-click on a project row.
      item.oncontextmenu = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
        if (root == null || p.project_id === undefined) return
        const id = p.project_id
        const isArchived = p.status === 'ARCHIVED'
        const ctxItems: ContextMenuItem[] = [
          { label: t('common', 'common.action.open'), hint: p.status ?? '', onPick: () => onPick(id) },
          { label: `✎ ${t('common', 'common.action.rename')}`, onPick: () => openRenameModal(root, id, p.name ?? '', () => state.rerender()) },
          { label: t('common', 'common.action.copyName'), hint: p.name ?? '', onPick: () => copyText(p.name ?? id) },
        ]
        if (isArchived) {
          ctxItems.push({
            label: `↩ ${t('common', 'common.action.restore')}`,
            divider: true,
            onPick: () => { void api(`/v1/projects/${encodeURIComponent(id)}/unarchive`, { method: 'POST' }).then(() => state.rerender()) },
          })
          ctxItems.push({
            label: `⌫ ${t('shell', 'shell.sidebar.deleteTitle')}`,
            onPick: () => openDeleteProjectModal(root, {
              project_id: id, name: p.name ?? id, status: p.status ?? '', revision: p.revision ?? 0,
            }, () => {
              chatDiscardProject(id)
              if (state.projectId === id) state.projectId = undefined
              showToast(rootHost(), t('shell', 'shell.deleteProject.deleted', { name: p.name ?? id }))
              state.rerender()
            }),
          })
        } else {
          ctxItems.push({
            label: `🗄 ${t('common', 'common.action.archive')}`,
            hint: t('shell', 'shell.sidebar.archiveHint'),
            divider: true,
            onPick: () => { void api(`/v1/projects/${encodeURIComponent(id)}/archive`, { method: 'POST' }).then(() => state.rerender()) },
          })
        }
        ctxItems.push(
          { label: `⧉ ${t('common', 'common.action.details')}`, onPick: () => { void openProjectDetailModal(root, id) } },
          { label: t('common', 'common.action.copyProjectId'), hint: id, onPick: () => copyText(id) },
        )
        openContextMenu(root, event.clientX, event.clientY, ctxItems)
      }
      // dsh-web project drawer: double-click opens the full detail modal.
      item.ondblclick = (event) => {
        event.stopPropagation()
        if (p.project_id === undefined) return
        const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
        if (root != null) void openProjectDetailModal(root, p.project_id)
      }
      // dsh-web "session actions": rename + archive/restore (hover only).
      const actionsWrap = el('span')
      actionsWrap.style.cssText = 'display:none;align-items:center;gap:2px;flex-shrink:0'
      const renameBtn = el('span', 'ws-rename', '✎')
      renameBtn.title = t('shell', 'shell.sidebar.renameTitle')
      renameBtn.onclick = (event) => {
        event.stopPropagation()
        if (p.project_id === undefined) return
        const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
        if (root != null) openRenameModal(root, p.project_id, p.name ?? '', () => state.rerender())
      }
      const archived = p.status === 'ARCHIVED'
      const arcBtn = el('span', 'ws-rename', archived ? '↩' : '🗄')
      arcBtn.title = archived ? t('shell', 'shell.sidebar.restoreTitle') : t('shell', 'shell.sidebar.archiveTitle')
      arcBtn.onclick = async (event) => {
        event.stopPropagation()
        if (p.project_id === undefined) return
        if (!archived) {
          const ok = await api(`/v1/projects/${encodeURIComponent(p.project_id)}/archive`, { method: 'POST' })
          if (ok === null) { state.lastError = t('shell', 'shell.sidebar.archiveFailed'); return }
          showToast(rootHost(), t('shell', 'shell.sidebar.archived', { name: p.name ?? p.project_id ?? '' }))
        } else {
          const ok = await api(`/v1/projects/${encodeURIComponent(p.project_id)}/unarchive`, { method: 'POST' })
          if (ok === null) { state.lastError = t('shell', 'shell.sidebar.restoreFailed'); return }
          showToast(rootHost(), t('shell', 'shell.sidebar.restored', { name: p.name ?? p.project_id ?? '' }))
        }
        state.rerender()
      }
      actionsWrap.append(renameBtn, arcBtn)
      if (archived && p.project_id !== undefined) {
        const deleteBtn = el('span', 'ws-rename', '⌫')
        deleteBtn.title = t('shell', 'shell.sidebar.deleteTitle')
        deleteBtn.onclick = (event) => {
          event.stopPropagation()
          const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
          if (root === null) return
          const id = p.project_id!
          openDeleteProjectModal(root, {
            project_id: id, name: p.name ?? id, status: p.status ?? '', revision: p.revision ?? 0,
          }, () => {
            chatDiscardProject(id)
            if (state.projectId === id) state.projectId = undefined
            showToast(rootHost(), t('shell', 'shell.deleteProject.deleted', { name: p.name ?? id }))
            state.rerender()
          })
        }
        actionsWrap.appendChild(deleteBtn)
      }
      item.appendChild(actionsWrap)
      list.appendChild(item)
    }
  }
  search.oninput = () => { sidebarQuery = search.value; renderRows() }
  renderRows()
  sidebar.appendChild(list)

  const foot = el('div', 'sidebar-foot')
  foot.style.cssText = 'display:flex;align-items:center;gap:8px;justify-content:space-between'
  // dsh-web overview: activity snapshot under the project list.
  const activeCount = projects.filter(p => isProjectActive(p.status)).length
  const blockedCount = projects.filter(p => p.status === 'BLOCKED_GATE').length
  const footStats = el('span', 'muted', t('shell', 'shell.sidebar.stats', { active: String(activeCount), blocked: String(blockedCount) }))
  footStats.style.cssText = 'font-size:9.5px;flex-shrink:0'
  const settingsBtn = el('button', 'hbtn', t('shell', 'shell.settings.title'))
  settingsBtn.title = t('shell', 'shell.settings.buttonTitle')
  settingsBtn.onclick = () => {
    const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
    if (root != null) openSettingsModal(root)
  }
  if (!sidebarSelecting) {
    const selectBtn = el('button', 'hbtn', `☑ ${t('common', 'common.action.select')}`)
    selectBtn.title = t('shell', 'shell.sidebar.selectTitle')
    selectBtn.setAttribute('aria-pressed', 'false')
    selectBtn.onclick = () => {
      sidebarSelecting = true
      sidebarSelected.clear()
      renderSidebar(sidebar, projects, activeId, onPick, sidebarToggle)
    }
    foot.append(footLabel, footStats, selectBtn, settingsBtn)
  } else {
    const doneBtn = el('button', 'hbtn', t('common', 'common.action.done'))
    doneBtn.onclick = () => {
      sidebarSelecting = false
      sidebarSelected.clear()
      renderSidebar(sidebar, projects, activeId, onPick, sidebarToggle)
    }
    const countLabel = el('span', '', t('common', 'common.selected', { count: String(sidebarSelected.size) }))
    const archiveSel = el('button', 'hbtn', `🗄 ${t('common', 'common.action.archive')}`)
    archiveSel.disabled = sidebarSelected.size === 0
    archiveSel.onclick = async () => {
      for (const id of sidebarSelected) {
        await api(`/v1/projects/${encodeURIComponent(id)}/archive`, { method: 'POST' })
      }
      showToast(rootHost(), t('shell', 'shell.sidebar.archivedMany', { count: String(sidebarSelected.size) }))
      sidebarSelecting = false
      sidebarSelected.clear()
      state.rerender()
    }
    // dsh-web compare: side-by-side view of the selected projects.
    const compareBtn = el('button', 'hbtn', `⇄ ${t('shell', 'shell.compare.button')}`)
    compareBtn.disabled = sidebarSelected.size < 2
    compareBtn.onclick = () => {
      const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
      if (root !== null && sidebarSelected.size >= 2) {
        void openCompareModal(root, [...sidebarSelected])
      }
    }
    foot.append(countLabel, footStats, archiveSel, compareBtn, doneBtn)
  }
  sidebar.appendChild(foot)
}

/** Multi-select mode for the sidebar (dsh-web bulk session actions). */
let sidebarSelecting = false
let sidebarSelected = new Set<string>()
