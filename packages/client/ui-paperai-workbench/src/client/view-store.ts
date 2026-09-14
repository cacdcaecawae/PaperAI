/** Browser preferences for document layout; document content remains in the workbench controller. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

type ViewState = { writing: boolean; zoom: 'fit' | number }
type ViewActions = {
  setWriting: (state: ViewState, writing: boolean) => void
  setZoom: (state: ViewState, zoom: 'fit' | number) => void
}

/** Create the writing/collaboration and zoom preferences, validating browser-stored values on restore.
 * @returns Entry store handle for document view preferences.
 */
export function createWorkbenchViewStore(): EngineStoreHandle<ViewState, ViewActions> {
  const handle = defineStore({
    persist: 'paperai.workbench.view',
    init: () => ({ writing: true, zoom: 'fit' as 'fit' | number }),
    actions: {
      setWriting: (state, writing: boolean) => { state.writing = writing },
      setZoom: (state, zoom: 'fit' | number) => { state.zoom = zoom },
    },
  })
  return {
    ...handle,
    create(scopeKey?: string) {
      const instance = handle.create(scopeKey)
      const value: unknown = instance.getSnapshot()
      const fields = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
      instance.store.set({
        writing: typeof fields.writing === 'boolean' ? fields.writing : true,
        zoom: typeof fields.zoom === 'number' && [50, 75, 100, 125, 150, 200].includes(fields.zoom) ? fields.zoom : 'fit',
      })
      return instance
    },
  }
}
