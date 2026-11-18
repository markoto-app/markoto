import type { CDPSession, Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { Pool } from 'pg'

// The documents explorer (dashboard "My documents" and a workspace's
// Documents tab) for the flows: stable locators for rows, the tree and the
// dialogs, a touch long-press, and API helpers that set up folders and
// documents without recording them.

const TEST_DATABASE_URL = 'postgres://ypad:testpassword@localhost:5433/ypad_test'

function exactText(text: string): RegExp {
  return new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
}

export class ExplorerPage {
  constructor(public readonly page: Page) {}

  get root(): Locator {
    return this.page.getByTestId('explorer')
  }

  get list(): Locator {
    return this.page.getByTestId('explorer-list')
  }

  get tree(): Locator {
    return this.page.getByTestId('explorer-tree')
  }

  get breadcrumb(): Locator {
    return this.page.getByTestId('explorer-breadcrumb')
  }

  get rows(): Locator {
    return this.list.locator('tbody tr[data-key]')
  }

  /** The list row whose name is exactly `name`. */
  row(name: string): Locator {
    return this.rows.filter({ has: this.page.locator('[data-testid="explorer-item-name"]', { hasText: exactText(name) }) })
  }

  /** A folder of the tree beside the list, by name. */
  treeNode(name: string): Locator {
    return this.tree.locator('[data-slot="link"]').filter({ hasText: exactText(name) })
  }

  get renameInput(): Locator {
    return this.page.getByTestId('explorer-rename-input').locator('input')
  }

  get newButton(): Locator {
    return this.page.getByTestId('explorer-new')
  }

  get search(): Locator {
    return this.page.getByTestId('explorer-search').locator('input')
  }

  get selectionBar(): Locator {
    return this.page.getByTestId('explorer-selection-bar')
  }

  menuItem(name: RegExp): Locator {
    return this.page.getByRole('menuitem', { name })
  }

  /** Wait until the list shows rows (or its empty state) after a load. */
  async waitForList(): Promise<void> {
    await expect(this.root).toBeVisible({ timeout: 15_000 })
    await expect(this.rows.first().or(this.page.getByTestId('explorer-empty'))).toBeVisible({ timeout: 15_000 })
  }

  /** Name shown in the list for the row with key `key` (`f:<id>` / `d:<id>`). */
  rowByKey(key: string): Locator {
    return this.list.locator(`tbody tr[data-key="${key}"]`)
  }

  /**
   * Press Tab until a row of the list has the keyboard focus (the list is
   * one tab stop: only the focused row takes Tab). Fails after `max` presses.
   */
  async tabIntoList(max = 40): Promise<void> {
    for (let i = 0; i < max; i++) {
      const inList = await this.page.evaluate(() => !!document.activeElement?.closest('[data-testid="explorer-list"] tr[data-key]'))
      if (inList) return
      await this.page.keyboard.press('Tab')
    }
    throw new Error('[tabIntoList] no row of the list took the focus')
  }

  /** Key (`f:<id>` / `d:<id>`) of the row that has the keyboard focus, or null. */
  async focusedKey(): Promise<string | null> {
    return this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('tr[data-key]')?.dataset.key ?? null)
  }

  /**
   * A finger held on `target` for `ms`: touch events through the browser's
   * input pipeline, the way a phone delivers a long press.
   */
  async longPress(target: Locator, ms = 900): Promise<void> {
    const box = await target.boundingBox()
    if (!box) throw new Error('[longPress] target has no box')
    const x = box.x + Math.min(box.width / 3, 80)
    const y = box.y + box.height / 2
    const cdp: CDPSession = await this.page.context().newCDPSession(this.page)
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      await this.page.waitForTimeout(ms)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally {
      await cdp.detach()
    }
  }
}

// ---------- set-up through the API ----------

type Scope = { workspaceId?: string | null }

export async function apiCreateFolder(page: Page, name: string, opts: Scope & { parentId?: string | null } = {}): Promise<string> {
  const url = opts.workspaceId ? `/api/workspaces/${opts.workspaceId}/folders` : '/api/user/folders'
  const res = await page.request.post(url, { data: { name, parentId: opts.parentId ?? null } })
  if (!res.ok()) throw new Error(`[apiCreateFolder] ${res.status()} ${await res.text()}`)
  const body = await res.json() as { folder: { folderId: string } }
  return body.folder.folderId
}

export async function apiCreateDoc(
  page: Page,
  doc: Scope & { title: string, content?: string, folderId?: string | null }
): Promise<string> {
  const res = await page.request.post('/api/docs', {
    data: {
      title: doc.title,
      ...(doc.content !== undefined ? { content: doc.content } : {}),
      ...(doc.workspaceId ? { workspaceId: doc.workspaceId } : {}),
      ...(doc.folderId ? { folderId: doc.folderId } : {})
    }
  })
  if (!res.ok()) throw new Error(`[apiCreateDoc] ${res.status()} ${await res.text()}`)
  return (await res.json() as { docId: string }).docId
}

export async function apiCreateWorkspace(page: Page, name: string): Promise<string> {
  const res = await page.request.post('/api/workspaces', { data: { name } })
  if (!res.ok()) throw new Error(`[apiCreateWorkspace] ${res.status()} ${await res.text()}`)
  return (await res.json() as { workspaceId: string }).workspaceId
}

interface ListedDoc { docId: string, title: string, folderId: string | null }
interface ListedFolder { folderId: string, parentId: string | null, name: string }

/** Documents of one folder (`root`, `all` or a folder id) of a scope. */
export async function apiListDocs(page: Page, folder: string, opts: Scope = {}): Promise<ListedDoc[]> {
  const url = opts.workspaceId ? `/api/workspaces/${opts.workspaceId}/documents` : '/api/user/personal-documents'
  const res = await page.request.get(url, { params: { folder, limit: 200 } })
  if (!res.ok()) throw new Error(`[apiListDocs] ${res.status()} ${await res.text()}`)
  return (await res.json() as { items: ListedDoc[] }).items
}

export async function apiListFolders(page: Page, opts: Scope = {}): Promise<ListedFolder[]> {
  const url = opts.workspaceId ? `/api/workspaces/${opts.workspaceId}/folders` : '/api/user/folders'
  const res = await page.request.get(url)
  if (!res.ok()) throw new Error(`[apiListFolders] ${res.status()} ${await res.text()}`)
  return (await res.json() as { folders: ListedFolder[] }).folders
}

/** Add an existing user to a workspace with `role` (the invitation is another flow's story). */
export async function dbAddMember(workspaceId: string, userId: number, role: 'admin' | 'editor' | 'viewer'): Promise<void> {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 })
  try {
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [workspaceId, userId, role]
    )
  } finally {
    await pool.end()
  }
}
