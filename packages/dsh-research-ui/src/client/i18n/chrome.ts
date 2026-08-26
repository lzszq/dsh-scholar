/**
 * Pure chrome-copy model (acceptance-tests.md §8 / §13.4): the shell's
 * once-built chrome — tab groups, tab labels/descriptions, model selector
 * choices — is defined here as FUNCTIONS that evaluate
 * `t()` against the CURRENT locale on every call. The DOM layer re-paints
 * from these on locale switch, so nothing snapshots copy at init time.
 * Kept free of DOM so unit tests can assert zh/en re-evaluation purely.
 */
import { t } from './index'
import { readNavigationVisibility, type NavigationVisibility } from '../navigation-preferences'
import { scholarModelUsability, type ScholarModelCatalogEntry } from '../../shared/model-catalog'

export interface ChromeTab { key: string; label: string; description: string }
export interface ChromeTabGroup { label: string; tabs: ChromeTab[] }
export interface ChromeModelChoice { id: string; label: string; disabled?: boolean; visual?: boolean }
export type ChromeModelCatalogEntry = ScholarModelCatalogEntry

/** Tab groups with labels/descriptions in the CURRENT locale. */
export function chromeTabGroups(visibility: NavigationVisibility = readNavigationVisibility()): ChromeTabGroup[] {
  const groups: ChromeTabGroup[] = [
    {
      label: t('shell', 'shell.tabs.group.research'),
      tabs: [
        { key: 'chat', label: t('shell', 'shell.tab.chat'), description: t('shell', 'shell.tab.chat.desc') },
        { key: 'phase', label: t('shell', 'shell.tab.phase'), description: t('shell', 'shell.tab.phase.desc') },
      ],
    },
    {
      label: t('shell', 'shell.tabs.group.execution'),
      tabs: [
        { key: 'gates', label: t('shell', 'shell.tab.gates'), description: t('shell', 'shell.tab.gates.desc') },
        { key: 'runs', label: t('shell', 'shell.tab.runs'), description: t('shell', 'shell.tab.runs.desc') },
        { key: 'terminal', label: t('shell', 'shell.tab.terminal'), description: t('shell', 'shell.tab.terminal.desc') },
        // PTY-01 (hardening §5): Interactive Terminal (real pty session).
        { key: 'pty', label: t('shell', 'shell.tab.pty'), description: t('shell', 'shell.tab.pty.desc') },
      ],
    },
    {
      label: t('shell', 'shell.tabs.group.review'),
      tabs: [
        { key: 'artifacts', label: t('shell', 'shell.tab.artifacts'), description: t('shell', 'shell.tab.artifacts.desc') },
        { key: 'evidence', label: t('shell', 'shell.tab.evidence'), description: t('shell', 'shell.tab.evidence.desc') },
        { key: 'manuscript', label: t('shell', 'shell.tab.manuscript'), description: t('shell', 'shell.tab.manuscript.desc') },
        // TRAJ-01/SUBAGENT-01 (hardening §5): Trajectory / Topology tabs.
        { key: 'trajectory', label: t('shell', 'shell.tab.trajectory'), description: t('shell', 'shell.tab.trajectory.desc') },
        { key: 'topology', label: t('shell', 'shell.tab.topology'), description: t('shell', 'shell.tab.topology.desc') },
        // WORK-01 (hardening §5): generic VS Code-style Workspace tree/tabs.
        { key: 'workspace', label: t('shell', 'shell.tab.workspace'), description: t('shell', 'shell.tab.workspace.desc') },
      ],
    },
    {
      label: t('shell', 'shell.tabs.group.operations'),
      tabs: visibility.budgetPage ? [
        { key: 'budget', label: t('shell', 'shell.tab.budget'), description: t('shell', 'shell.tab.budget.desc') },
      ] : [],
    },
  ]
  return groups
}

/** Flat tab list in the CURRENT locale (order = Alt+1..9 order). */
export function chromeTabs(visibility: NavigationVisibility = readNavigationVisibility()): ChromeTab[] {
  return chromeTabGroups(visibility).flatMap(group => group.tabs)
}

/** Research-agent model selector choices in the CURRENT locale. */
export function chromeModelChoices(models: readonly ChromeModelCatalogEntry[] = []): ChromeModelChoice[] {
  return [
    { id: '', label: t('shell', 'shell.model.auto') },
    ...models.map(model => {
      const usability = scholarModelUsability(model)
      return {
        id: model.id,
        label: `${usability.visual ? '👁 ' : ''}${model.name}`,
        disabled: !usability.selectable,
        visual: usability.visual,
      }
    }),
  ]
}
