import { invoke } from '@tauri-apps/api/core'

/** Reads the identity mirror kept outside the identifier-scoped data directory. */
export async function loadDurableIdentity(): Promise<string | null> {
  return invoke<string | null>('load_durable_identity')
}

export async function saveDurableIdentity(content: string): Promise<void> {
  await invoke('save_durable_identity', { content })
}
